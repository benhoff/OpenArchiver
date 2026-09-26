// Run after building types/backend:
// node packages/backend/scripts/test-archived-email.cjs
// Set ARCHIVED_EMAIL_TEST_DATABASE_URL to run the PostgreSQL regressions too.
// Database tests use a unique schema and remove only that schema on completion.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createRequire } = require('node:module');
const { runInNewContext } = require('node:vm');
const { randomUUID, createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const postgres = require('postgres');
const { drizzle } = require('drizzle-orm/postgres-js');
const { eq } = require('drizzle-orm');
const schema = require('../dist/database/schema');

// Substitute infrastructure only; run the compiled service and its real SQL,
// schema, cursor handling, and MIME parser without starting application workers.
function loadService(db, filter, groupIds) {
	const filename = resolve(__dirname, '../dist/services/ArchivedEmailService.js');
	const localRequire = createRequire(filename);
	const mocks = {
		'../database': { db },
		'./FilterBuilder': { FilterBuilder: { create: async () => ({ drizzleFilter: filter }) } },
		'./IngestionService': { IngestionService: { findGroupSourceIds: async () => groupIds } },
		'./AuditService': { AuditService: class {} },
		'./AuthorizationService': {},
		'./StorageService': {},
		'./SearchService': {},
		'../helpers/deletionGuard': {},
		'../hooks/RetentionHook': {},
		'../config/logger': {},
	};
	const exports = {};
	runInNewContext(
		readFileSync(filename, 'utf8'),
		{
			exports,
			Buffer,
			console,
			require: (id) => (Object.hasOwn(mocks, id) ? mocks[id] : localRequire(id)),
		},
		{ filename }
	);
	return exports.ArchivedEmailService;
}

const userId = randomUUID();
const options = { userId, limit: 1 };

test('cursor validation preserves precision and rejects mismatched scopes and old checkpoints', () => {
	const service = loadService({});
	const sentAt = '2026-09-26 10:00:00.123456+00';
	const encoded = service.encodeFeedCursor({ sentAt, id: userId });
	assert.equal(service.decodeFeedCursor(encoded).sentAt, sentAt);
	const scope = service.getChangesScope(options);
	const cursor = service.encodeChangesCursor({ v: 2, position: '9007199254740993', scope });
	assert.equal(service.decodeChangesCursor(cursor, scope).position, '9007199254740993');
	assert.throws(() => service.decodeChangesCursor(cursor, 'different-user-or-filter'));
	for (const invalid of ['', '!', Buffer.from('null').toString('base64url')]) {
		assert.throws(() => service.decodeChangesCursor(invalid, scope));
		assert.throws(() => service.decodeFeedCursor(invalid));
	}
	for (const position of ['-1', '1.5', '9223372036854775808']) {
		assert.throws(() =>
			service.decodeChangesCursor(
				service.encodeChangesCursor({ v: 2, position, scope }),
				scope
			)
		);
	}
	assert.throws(() =>
		service.decodeChangesCursor(
			service.encodeChangesCursor({ v: 1, archivedAt: sentAt, id: userId, scope }),
			scope
		)
	);
});

test('content includes stripped attachments and deduplicates retained inline parts by hash', async () => {
	const inline = Buffer.from('inline fixture');
	const stored = [
		{ filename: 'report.pdf', contentType: 'application/pdf', size: 123, hash: 'stripped' },
		{
			filename: 'deduplicated-name.png',
			contentType: 'image/png',
			size: inline.length,
			hash: createHash('sha256').update(inline).digest('hex'),
		},
	];
	const query = { from: () => query, innerJoin: () => query, where: async () => stored };
	const service = loadService({ select: () => query });
	const MailComposer = require('nodemailer/lib/mail-composer');
	const raw = await new MailComposer({
		from: 'sender@example.com',
		to: 'recipient@example.com',
		subject: 'Fixture',
		html: '<p>Body</p><img src="cid:fixture">',
		attachments: [
			{
				filename: 'inline.png',
				content: inline,
				contentType: 'image/png',
				cid: 'fixture',
				contentDisposition: 'inline',
			},
		],
	})
		.compile()
		.build();
	const email = { id: userId, subject: 'Fixture', sentAt: new Date(), raw, hasAttachments: true };
	service.getArchivedEmailById = async () => email;
	const content = await service.getArchivedEmailContentById(userId, userId, {}, '127.0.0.1');
	assert.equal(content.attachments.length, 2);
	assert.equal(content.attachments[0].inline, true);
	assert.equal(content.attachments[1].filename, 'report.pdf');
	assert.equal(content.attachments[1].size, 123);
	assert(content.html.includes('cid:fixture'));
	assert(!content.html.includes('data:'));
	assert(!JSON.stringify(content).includes('stripped'));
	stored.length = 0; // Preserve-original mode has no stored attachment rows.
	assert.equal(
		(await service.getArchivedEmailContentById(userId, userId, {}, '')).attachments.length,
		1
	);
	service.getArchivedEmailById = async () => null;
	assert.equal(await service.getArchivedEmailContentById(userId, userId, {}, ''), null);
});

const databaseUrl = process.env.ARCHIVED_EMAIL_TEST_DATABASE_URL;
test('PostgreSQL change log and feed regressions', { skip: !databaseUrl }, async (t) => {
	const namespace = `archive_feed_test_${randomUUID().replaceAll('-', '')}`;
	const admin = postgres(databaseUrl, { max: 1, onnotice: () => {} });
	const client = postgres(databaseUrl, {
		max: 5,
		connection: { search_path: namespace },
		onnotice: () => {},
	});
	let a;
	let b;
	try {
		await admin.unsafe(`CREATE SCHEMA ${namespace}`);
		await client.unsafe(`
			CREATE TABLE ingestion_sources (id uuid PRIMARY KEY);
			CREATE TABLE archived_emails (
				id uuid PRIMARY KEY DEFAULT gen_random_uuid(), thread_id text,
				ingestion_source_id uuid NOT NULL REFERENCES ingestion_sources(id),
				user_email text NOT NULL DEFAULT 'reader@example.com', message_id_header text,
				provider_message_id text, sent_at timestamptz NOT NULL DEFAULT now(),
				subject text, sender_name text, sender_email text NOT NULL DEFAULT 'sender@example.com',
				recipients jsonb, has_attachments boolean NOT NULL DEFAULT false,
				archived_at timestamptz NOT NULL DEFAULT now(), path text, tags jsonb
			);
		`);
		// Historical rows exist before the log is installed and must not be replayed.
		const sourceId = randomUUID();
		await client`INSERT INTO ingestion_sources (id) VALUES (${sourceId})`;
		await client`INSERT INTO archived_emails (ingestion_source_id) VALUES (${sourceId})`;
		for (const migration of [
			'0038_archived_email_feed_indexes',
			'0039_archived_email_change_feed_indexes',
			'0040_archived_email_change_log',
		]) {
			const sql = readFileSync(
				resolve(__dirname, `../src/database/migrations/${migration}.sql`),
				'utf8'
			);
			await client.begin(async (tx) => {
				for (const statement of sql.split('--> statement-breakpoint'))
					await tx.unsafe(statement);
			});
		}
		const db = drizzle(client, { schema });
		const service = loadService(db, undefined, [sourceId]);
		const initial = await service.getArchivedEmailChanges(options);
		assert.equal(initial.items.length, 0);
		a = await client.reserve();
		b = await client.reserve();
		const insert = async (connection, date, path = 'Inbox/') => {
			const [row] =
				await connection`INSERT INTO archived_emails (ingestion_source_id, archived_at, sent_at, path)
				VALUES (${sourceId}, ${date}, ${date}, ${path}) RETURNING id`;
			return row.id;
		};

		await t.test(
			'an earlier transaction inserting after a later commit is still delivered',
			async () => {
				await a`BEGIN`;
				const newer = await insert(b, '2026-09-26T12:00:00Z');
				const first = await service.getArchivedEmailChanges({
					...options,
					cursor: initial.nextCursor,
				});
				assert.equal(first.items[0].id, newer);
				const older = await insert(a, '2000-01-01T00:00:00Z');
				await a`COMMIT`;
				const second = await service.getArchivedEmailChanges({
					...options,
					cursor: first.nextCursor,
				});
				assert.equal(second.items[0].id, older);
			}
		);

		await t.test('overlapping inserts cannot commit past an in-flight checkpoint', async () => {
			await a`BEGIN`;
			const firstId = await insert(a, '2001-01-01T00:00:00Z');
			const checkpoint = await service.getArchivedEmailChanges(options);
			const [backend] = await b`SELECT pg_backend_pid() AS pid`;
			const pending = insert(b, '2026-09-26T13:00:00Z');
			try {
				let blocked = false;
				for (let i = 0; i < 100; i++) {
					const [activity] =
						await client`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${backend.pid}`;
					if (activity.wait_event_type === 'Lock') {
						blocked = true;
						break;
					}
					await delay(20);
				}
				assert(blocked, 'second writer must wait for the first transaction');
				const empty = await service.getArchivedEmailChanges({
					...options,
					cursor: checkpoint.nextCursor,
				});
				assert.equal(empty.items.length, 0);
				assert.equal(empty.nextCursor, checkpoint.nextCursor);
			} finally {
				await a`COMMIT`;
			}
			const secondId = await pending;
			const page = await service.getArchivedEmailChanges({
				...options,
				cursor: checkpoint.nextCursor,
			});
			assert.equal(page.items[0].id, firstId);
			assert.equal(page.hasMore, true);
			const next = await service.getArchivedEmailChanges({
				...options,
				cursor: page.nextCursor,
			});
			assert.equal(next.items[0].id, secondId);
			assert.equal(next.hasMore, false);
		});

		await t.test(
			'rollback, filtered empty initialization, access restrictions, and deletion',
			async () => {
				const filtered = { ...options, path: 'Other/', ingestionSourceId: sourceId };
				const checkpoint = await service.getArchivedEmailChanges(filtered);
				await a`BEGIN`;
				await insert(a, '2002-01-01T00:00:00Z', 'Other/');
				await a`ROLLBACK`;
				await insert(b, '2003-01-01T00:00:00Z', 'Inbox/');
				const wanted = await insert(b, '2004-01-01T00:00:00Z', 'Other/');
				const result = await service.getArchivedEmailChanges({
					...filtered,
					cursor: checkpoint.nextCursor,
				});
				assert.equal(result.items.length, 1);
				assert.equal(result.items[0].id, wanted);
				assert.equal(result.items[0].recipients.length, 0);
				const restricted = loadService(
					db,
					eq(schema.archivedEmails.userEmail, 'no-access@example.com'),
					[sourceId]
				);
				assert.equal(
					(
						await restricted.getArchivedEmailChanges({
							...filtered,
							cursor: checkpoint.nextCursor,
						})
					).items.length,
					0
				);
				await assert.rejects(
					service.getArchivedEmailChanges({ ...options, cursor: checkpoint.nextCursor })
				);
				await assert.rejects(service.getArchivedEmailChanges({ ...options, cursor: '' }));
				await client`DELETE FROM archived_emails WHERE id = ${wanted}`;
				assert.equal(
					(
						await service.getArchivedEmailChanges({
							...filtered,
							cursor: checkpoint.nextCursor,
						})
					).items.length,
					0
				);
				assert.equal((await service.getArchivedEmailChanges(options)).items.length, 0);
			}
		);

		await t.test(
			'history pagination preserves microseconds and tied timestamp ordering',
			async () => {
				const ids = [];
				for (const date of [
					'2026-09-26 15:00:00.123456+00',
					'2026-09-26 15:00:00.123456+00',
					'2026-09-26 15:00:00.123455+00',
				]) {
					ids.push(await insert(b, date, 'Precision/'));
				}
				const seen = [];
				let cursor;
				do {
					const page = await service.getArchivedEmailFeed({
						...options,
						path: 'Precision/',
						cursor,
					});
					seen.push(...page.items.map((row) => row.id));
					cursor = page.nextCursor;
				} while (cursor);
				assert.deepEqual(seen, [ids[0], ids[1]].sort().reverse().concat(ids[2]));
			}
		);

		await t.test(
			'empty polls advance past nonmatching rows and survive deletion of all history',
			async () => {
				const filtered = { ...options, path: 'Empty/' };
				const checkpoint = await service.getArchivedEmailChanges(filtered);
				await insert(b, '2000-01-01T00:00:00Z', 'NotEmpty/');
				const empty = await service.getArchivedEmailChanges({
					...filtered,
					cursor: checkpoint.nextCursor,
				});
				assert.equal(empty.items.length, 0);
				assert.notEqual(empty.nextCursor, checkpoint.nextCursor);
				await client`DELETE FROM archived_emails`;
				const id = await insert(b, '2000-01-01T00:00:00Z', 'Empty/');
				const result = await service.getArchivedEmailChanges({
					...filtered,
					cursor: empty.nextCursor,
				});
				assert.equal(result.items[0].id, id);
			}
		);

		await t.test('positions beyond JavaScript integer precision remain exact', async () => {
			await client`UPDATE archived_email_change_counter SET position = 9007199254740992`;
			const checkpoint = await service.getArchivedEmailChanges(options);
			const id = await insert(b, '2000-01-01T00:00:00Z');
			const result = await service.getArchivedEmailChanges({
				...options,
				cursor: checkpoint.nextCursor,
			});
			assert.equal(result.items[0].id, id);
			assert.equal(
				JSON.parse(Buffer.from(result.nextCursor, 'base64url')).position,
				'9007199254740993'
			);
		});
	} finally {
		if (a) {
			await a`ROLLBACK`;
			a.release();
		}
		if (b) {
			await b`ROLLBACK`;
			b.release();
		}
		await client.end();
		await admin.unsafe(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
		await admin.end();
	}
});
