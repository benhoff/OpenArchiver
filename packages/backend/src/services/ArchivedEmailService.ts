import { count, desc, eq, asc, and, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../database';
import {
	archivedEmails,
	archivedEmailChanges,
	archivedEmailChangeCounter,
	attachments,
	emailAttachments,
	ingestionSources,
} from '../database/schema';
import { FilterBuilder } from './FilterBuilder';
import { AuthorizationService } from './AuthorizationService';
import type {
	PaginatedArchivedEmails,
	ArchivedEmail,
	ArchivedEmailContent,
	ArchivedEmailContentAddress,
	ArchivedEmailChangesResponse,
	ArchivedEmailFeedResponse,
	Recipient,
	ThreadEmail,
} from '@open-archiver/types';
import { StorageService } from './StorageService';
import { SearchService } from './SearchService';
import { IngestionService } from './IngestionService';
import type { Readable } from 'stream';
import { AuditService } from './AuditService';
import { User } from '@open-archiver/types';
import { checkDeletionEnabled } from '../helpers/deletionGuard';
import { RetentionHook } from '../hooks/RetentionHook';
import { logger } from '../config/logger';
import { simpleParser, type AddressObject } from 'mailparser';
import { createHash } from 'crypto';

interface DbRecipients {
	to: { name: string; address: string }[];
	cc: { name: string; address: string }[];
	bcc: { name: string; address: string }[];
}

interface ArchivedEmailFeedCursor {
	sentAt: string;
	id: string;
}

interface ArchivedEmailChangesCursor {
	v: 2;
	position: string;
	scope: string;
}

export interface ArchivedEmailFeedOptions {
	userId: string;
	path?: string;
	ingestionSourceId?: string;
	cursor?: string;
	limit: number;
}

export class InvalidArchivedEmailFeedCursorError extends Error {
	constructor() {
		super('Invalid message feed cursor.');
		this.name = 'InvalidArchivedEmailFeedCursorError';
	}
}

export class InvalidArchivedEmailChangesCursorError extends Error {
	constructor() {
		super('Invalid message changes cursor or cursor filters do not match this request.');
		this.name = 'InvalidArchivedEmailChangesCursorError';
	}
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function streamToBuffer(stream: Readable): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		stream.on('data', (chunk) => chunks.push(chunk));
		stream.on('error', reject);
		stream.on('end', () => resolve(Buffer.concat(chunks)));
	});
}

export class ArchivedEmailService {
	private static auditService = new AuditService();

	private static encodeFeedCursor(cursor: ArchivedEmailFeedCursor): string {
		return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
	}

	private static decodeFeedCursor(cursor: string): ArchivedEmailFeedCursor {
		try {
			if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
				throw new InvalidArchivedEmailFeedCursorError();
			}

			const parsed = JSON.parse(
				Buffer.from(cursor, 'base64url').toString('utf8')
			) as Partial<ArchivedEmailFeedCursor>;
			if (
				typeof parsed.sentAt !== 'string' ||
				Number.isNaN(Date.parse(parsed.sentAt)) ||
				typeof parsed.id !== 'string' ||
				!UUID_PATTERN.test(parsed.id)
			) {
				throw new InvalidArchivedEmailFeedCursorError();
			}

			return { sentAt: parsed.sentAt, id: parsed.id };
		} catch (error) {
			if (error instanceof InvalidArchivedEmailFeedCursorError) {
				throw error;
			}
			throw new InvalidArchivedEmailFeedCursorError();
		}
	}

	private static getChangesScope(options: {
		userId: string;
		path?: string;
		ingestionSourceId?: string;
	}): string {
		return createHash('sha256')
			.update(
				JSON.stringify([
					options.userId,
					options.path ?? null,
					options.ingestionSourceId ?? null,
				])
			)
			.digest('base64url');
	}

	private static encodeChangesCursor(cursor: ArchivedEmailChangesCursor): string {
		return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
	}

	private static decodeChangesCursor(
		cursor: string,
		expectedScope: string
	): ArchivedEmailChangesCursor {
		try {
			if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
				throw new InvalidArchivedEmailChangesCursorError();
			}

			const parsed = JSON.parse(
				Buffer.from(cursor, 'base64url').toString('utf8')
			) as Partial<ArchivedEmailChangesCursor>;
			if (
				parsed.v !== 2 ||
				typeof parsed.position !== 'string' ||
				!/^(0|[1-9][0-9]{0,18})$/.test(parsed.position) ||
				BigInt(parsed.position) > 9223372036854775807n ||
				parsed.scope !== expectedScope
			) {
				throw new InvalidArchivedEmailChangesCursorError();
			}

			return parsed as ArchivedEmailChangesCursor;
		} catch (error) {
			if (error instanceof InvalidArchivedEmailChangesCursorError) {
				throw error;
			}
			throw new InvalidArchivedEmailChangesCursorError();
		}
	}

	private static mapAddressObject(
		address: AddressObject | AddressObject[] | undefined
	): ArchivedEmailContentAddress[] {
		if (!address) return [];

		const addressObjects = Array.isArray(address) ? address : [address];
		return addressObjects.flatMap((addressObject) =>
			addressObject.value
				.filter((value) => Boolean(value.address))
				.map((value) => ({
					name: value.name || null,
					email: value.address || '',
				}))
		);
	}

	private static mapRecipients(dbRecipients: unknown): Recipient[] {
		const { to = [], cc = [], bcc = [] } = (dbRecipients ?? {}) as DbRecipients;

		const allRecipients = [...to, ...cc, ...bcc];

		return allRecipients.map((r) => ({
			name: r.name,
			email: r.address,
		}));
	}

	/**
	 * Returns a stable, newest-first feed across every archive the caller may read.
	 * The optional path filter is an exact match against archived_emails.path.
	 */
	public static async getArchivedEmailFeed(
		options: ArchivedEmailFeedOptions
	): Promise<ArchivedEmailFeedResponse> {
		const { drizzleFilter } = await FilterBuilder.create(options.userId, 'archive', 'read');
		const conditions: (SQL | undefined)[] = [drizzleFilter];

		if (options.path !== undefined) {
			conditions.push(eq(archivedEmails.path, options.path));
		}

		if (options.ingestionSourceId) {
			const groupIds = await IngestionService.findGroupSourceIds(options.ingestionSourceId);
			conditions.push(
				groupIds.length === 1
					? eq(archivedEmails.ingestionSourceId, groupIds[0])
					: inArray(archivedEmails.ingestionSourceId, groupIds)
			);
		}

		if (options.cursor !== undefined) {
			const cursor = this.decodeFeedCursor(options.cursor);
			conditions.push(
				sql`(${archivedEmails.sentAt}, ${archivedEmails.id}) < (${cursor.sentAt}::timestamptz, ${cursor.id}::uuid)`
			);
		}

		const rows = await db
			.select({
				id: archivedEmails.id,
				threadId: archivedEmails.threadId,
				ingestionSourceId: archivedEmails.ingestionSourceId,
				userEmail: archivedEmails.userEmail,
				messageIdHeader: archivedEmails.messageIdHeader,
				providerMessageId: archivedEmails.providerMessageId,
				sentAt: archivedEmails.sentAt,
				cursorSentAt: sql<string>`${archivedEmails.sentAt}::text`,
				subject: archivedEmails.subject,
				senderName: archivedEmails.senderName,
				senderEmail: archivedEmails.senderEmail,
				recipients: archivedEmails.recipients,
				hasAttachments: archivedEmails.hasAttachments,
				archivedAt: archivedEmails.archivedAt,
				path: archivedEmails.path,
				tags: archivedEmails.tags,
			})
			.from(archivedEmails)
			.leftJoin(ingestionSources, eq(archivedEmails.ingestionSourceId, ingestionSources.id))
			.where(and(...conditions))
			.orderBy(desc(archivedEmails.sentAt), desc(archivedEmails.id))
			.limit(options.limit + 1);

		const hasMore = rows.length > options.limit;
		const pageRows = hasMore ? rows.slice(0, options.limit) : rows;
		const lastRow = pageRows.at(-1);

		return {
			items: pageRows.map((row) => ({
				id: row.id,
				threadId: row.threadId,
				ingestionSourceId: row.ingestionSourceId,
				userEmail: row.userEmail,
				messageIdHeader: row.messageIdHeader,
				providerMessageId: row.providerMessageId,
				sentAt: row.sentAt,
				subject: row.subject,
				senderName: row.senderName,
				senderEmail: row.senderEmail,
				recipients: this.mapRecipients(row.recipients),
				hasAttachments: row.hasAttachments,
				archivedAt: row.archivedAt,
				path: row.path,
				tags: (row.tags as string[] | null) || null,
			})),
			nextCursor:
				hasMore && lastRow
					? this.encodeFeedCursor({ sentAt: lastRow.cursorSentAt, id: lastRow.id })
					: null,
			hasMore,
		};
	}

	/**
	 * Returns emails added to the archive after a durable polling checkpoint.
	 * The first request establishes a checkpoint without replaying existing history.
	 */
	public static async getArchivedEmailChanges(
		options: ArchivedEmailFeedOptions
	): Promise<ArchivedEmailChangesResponse> {
		const { drizzleFilter } = await FilterBuilder.create(options.userId, 'archive', 'read');
		const conditions: (SQL | undefined)[] = [drizzleFilter];
		const scope = this.getChangesScope(options);

		if (options.path !== undefined) {
			conditions.push(eq(archivedEmails.path, options.path));
		}

		if (options.ingestionSourceId) {
			const groupIds = await IngestionService.findGroupSourceIds(options.ingestionSourceId);
			conditions.push(
				groupIds.length === 1
					? eq(archivedEmails.ingestionSourceId, groupIds[0])
					: inArray(archivedEmails.ingestionSourceId, groupIds)
			);
		}

		const cursor =
			options.cursor === undefined
				? undefined
				: this.decodeChangesCursor(options.cursor, scope);
		// Bound this poll to a committed prefix. Once it is drained, advance past
		// nonmatching/deleted entries too, so empty polls do not rescan old history.
		// In-flight inserts are beyond this position and appear on a later poll.
		const [checkpoint] = await db
			.select()
			.from(archivedEmailChangeCounter)
			.where(eq(archivedEmailChangeCounter.id, 1));
		if (!checkpoint) throw new Error('Archived email change counter is missing.');

		if (cursor === undefined) {
			return {
				items: [],
				nextCursor: this.encodeChangesCursor({
					v: 2,
					position: checkpoint.position.toString(),
					scope,
				}),
				hasMore: false,
			};
		}

		if (BigInt(cursor.position) > checkpoint.position) {
			throw new InvalidArchivedEmailChangesCursorError();
		}
		conditions.push(
			sql`${archivedEmailChanges.position} > ${cursor.position}::bigint`,
			sql`${archivedEmailChanges.position} <= ${checkpoint.position}`
		);

		const rows = await db
			.select({
				id: archivedEmails.id,
				threadId: archivedEmails.threadId,
				ingestionSourceId: archivedEmails.ingestionSourceId,
				userEmail: archivedEmails.userEmail,
				messageIdHeader: archivedEmails.messageIdHeader,
				providerMessageId: archivedEmails.providerMessageId,
				sentAt: archivedEmails.sentAt,
				subject: archivedEmails.subject,
				senderName: archivedEmails.senderName,
				senderEmail: archivedEmails.senderEmail,
				recipients: archivedEmails.recipients,
				hasAttachments: archivedEmails.hasAttachments,
				archivedAt: archivedEmails.archivedAt,
				changePosition: archivedEmailChanges.position,
				path: archivedEmails.path,
				tags: archivedEmails.tags,
			})
			.from(archivedEmailChanges)
			.innerJoin(archivedEmails, eq(archivedEmailChanges.emailId, archivedEmails.id))
			.leftJoin(ingestionSources, eq(archivedEmails.ingestionSourceId, ingestionSources.id))
			.where(and(...conditions))
			.orderBy(asc(archivedEmailChanges.position))
			.limit(options.limit + 1);

		const hasMore = rows.length > options.limit;
		const pageRows = hasMore ? rows.slice(0, options.limit) : rows;
		const lastRow = pageRows.at(-1);
		const position =
			hasMore && lastRow ? lastRow.changePosition.toString() : checkpoint.position.toString();

		return {
			items: pageRows.map((row) => ({
				id: row.id,
				threadId: row.threadId,
				ingestionSourceId: row.ingestionSourceId,
				userEmail: row.userEmail,
				messageIdHeader: row.messageIdHeader,
				providerMessageId: row.providerMessageId,
				sentAt: row.sentAt,
				subject: row.subject,
				senderName: row.senderName,
				senderEmail: row.senderEmail,
				recipients: this.mapRecipients(row.recipients),
				hasAttachments: row.hasAttachments,
				archivedAt: row.archivedAt,
				path: row.path,
				tags: (row.tags as string[] | null) || null,
			})),
			nextCursor: this.encodeChangesCursor({ v: 2, position, scope }),
			hasMore,
		};
	}

	public static async getArchivedEmails(
		ingestionSourceId: string,
		page: number,
		limit: number,
		userId: string
	): Promise<PaginatedArchivedEmails> {
		const offset = (page - 1) * limit;
		const { drizzleFilter } = await FilterBuilder.create(userId, 'archive', 'read');

		// Expand to the full merge group so emails from children appear when browsing a root source
		const groupIds = await IngestionService.findGroupSourceIds(ingestionSourceId);
		const sourceFilter =
			groupIds.length === 1
				? eq(archivedEmails.ingestionSourceId, groupIds[0])
				: inArray(archivedEmails.ingestionSourceId, groupIds);
		const where = and(sourceFilter, drizzleFilter);

		const countQuery = db
			.select({
				count: count(archivedEmails.id),
			})
			.from(archivedEmails)
			.leftJoin(ingestionSources, eq(archivedEmails.ingestionSourceId, ingestionSources.id));

		if (where) {
			countQuery.where(where);
		}

		const [total] = await countQuery;

		const itemsQuery = db
			.select()
			.from(archivedEmails)
			.leftJoin(ingestionSources, eq(archivedEmails.ingestionSourceId, ingestionSources.id))
			.orderBy(desc(archivedEmails.sentAt))
			.limit(limit)
			.offset(offset);

		if (where) {
			itemsQuery.where(where);
		}

		const results = await itemsQuery;
		const items = results.map((r) => r.archived_emails);

		return {
			items: items.map((item) => ({
				...item,
				recipients: this.mapRecipients(item.recipients),
				tags: (item.tags as string[] | null) || null,
				path: item.path || null,
			})),
			total: total.count,
			page,
			limit,
		};
	}

	public static async getArchivedEmailById(
		emailId: string,
		userId: string,
		actor: User,
		actorIp: string
	): Promise<ArchivedEmail | null> {
		const email = await db.query.archivedEmails.findFirst({
			where: eq(archivedEmails.id, emailId),
			with: {
				ingestionSource: true,
			},
		});

		if (!email) {
			return null;
		}

		const authorizationService = new AuthorizationService();
		const canRead = await authorizationService.can(userId, 'read', 'archive', email);

		if (!canRead) {
			return null;
		}

		await this.auditService.createAuditLog({
			actorIdentifier: actor.id,
			actionType: 'READ',
			targetType: 'ArchivedEmail',
			targetId: emailId,
			actorIp,
			details: {},
		});

		let threadEmails: ThreadEmail[] = [];

		// Expand thread query to the full merge group so threads can span across merged sources
		if (email.threadId) {
			const groupIds = await IngestionService.findGroupSourceIds(email.ingestionSourceId);
			const sourceFilter =
				groupIds.length === 1
					? eq(archivedEmails.ingestionSourceId, groupIds[0])
					: inArray(archivedEmails.ingestionSourceId, groupIds);
			threadEmails = await db.query.archivedEmails.findMany({
				where: and(eq(archivedEmails.threadId, email.threadId), sourceFilter),
				orderBy: [asc(archivedEmails.sentAt)],
				columns: {
					id: true,
					subject: true,
					sentAt: true,
					senderEmail: true,
				},
			});
		}

		const storage = new StorageService();
		const rawStream = await storage.get(email.storagePath);
		const raw = await streamToBuffer(rawStream as Readable);

		const mappedEmail = {
			...email,
			recipients: this.mapRecipients(email.recipients),
			raw,
			thread: threadEmails,
			tags: (email.tags as string[] | null) || null,
			path: email.path || null,
		};

		if (email.hasAttachments) {
			const emailAttachmentsResult = await db
				.select({
					id: attachments.id,
					filename: attachments.filename,
					mimeType: attachments.mimeType,
					sizeBytes: attachments.sizeBytes,
					storagePath: attachments.storagePath,
				})
				.from(emailAttachments)
				.innerJoin(attachments, eq(emailAttachments.attachmentId, attachments.id))
				.where(eq(emailAttachments.emailId, emailId));

			// const attachmentsWithRaw = await Promise.all(
			//     emailAttachmentsResult.map(async (attachment) => {
			//         const rawStream = await storage.get(attachment.storagePath);
			//         const raw = await streamToBuffer(rawStream as Readable);
			//         return { ...attachment, raw };
			//     })
			// );

			return {
				...mappedEmail,
				attachments: emailAttachmentsResult,
			};
		}

		return mappedEmail;
	}

	public static async getArchivedEmailContentById(
		emailId: string,
		userId: string,
		actor: User,
		actorIp: string
	): Promise<ArchivedEmailContent | null> {
		const email = await this.getArchivedEmailById(emailId, userId, actor, actorIp);
		if (!email?.raw) return null;

		const parsed = await simpleParser(email.raw, { skipImageLinks: true });
		const contentAttachments = parsed.attachments.map((attachment) => ({
			filename: attachment.filename || null,
			contentType: attachment.contentType,
			size: attachment.size,
			contentId: attachment.contentId || null,
			inline: attachment.contentDisposition === 'inline',
		}));

		// Default ingestion strips regular attachments from the EML. Include their
		// stored metadata, matching by content hash so retained MIME parts are not
		// duplicated (even when attachment deduplication has changed the filename).
		if (email.hasAttachments) {
			const mimeHashes = new Set(
				parsed.attachments.map((attachment) =>
					createHash('sha256').update(attachment.content).digest('hex')
				)
			);
			const stored = await db
				.select({
					filename: attachments.filename,
					contentType: attachments.mimeType,
					size: attachments.sizeBytes,
					hash: attachments.contentHashSha256,
				})
				.from(emailAttachments)
				.innerJoin(attachments, eq(emailAttachments.attachmentId, attachments.id))
				.where(eq(emailAttachments.emailId, emailId));
			for (const attachment of stored) {
				if (mimeHashes.has(attachment.hash)) continue;
				contentAttachments.push({
					filename: attachment.filename,
					contentType: attachment.contentType || 'application/octet-stream',
					size: attachment.size,
					contentId: null,
					inline: false,
				});
			}
		}
		const inReplyTo = Array.isArray(parsed.inReplyTo)
			? parsed.inReplyTo.join(' ')
			: parsed.inReplyTo || null;

		return {
			id: email.id,
			subject: parsed.subject || email.subject,
			sentAt: parsed.date || email.sentAt,
			messageId: parsed.messageId || email.messageIdHeader,
			inReplyTo,
			from: this.mapAddressObject(parsed.from),
			to: this.mapAddressObject(parsed.to),
			cc: this.mapAddressObject(parsed.cc),
			bcc: this.mapAddressObject(parsed.bcc),
			replyTo: this.mapAddressObject(parsed.replyTo),
			text: parsed.text || null,
			html: typeof parsed.html === 'string' ? parsed.html : null,
			attachments: contentAttachments,
		};
	}

	public static async deleteArchivedEmail(
		emailId: string,
		actor: User,
		actorIp: string,
		options: {
			systemDelete?: boolean;
			/**
			 * Human-readable name of the retention rule that triggered deletion
			 */
			governingRule?: string;
		} = {}
	): Promise<void> {
		checkDeletionEnabled({ allowSystemDelete: options.systemDelete });

		const canDelete = await RetentionHook.canDelete(emailId);
		if (!canDelete) {
			throw new Error('Deletion blocked by retention policy (Legal Hold or similar).');
		}

		const [email] = await db
			.select()
			.from(archivedEmails)
			.where(eq(archivedEmails.id, emailId));

		if (!email) {
			throw new Error('Archived email not found');
		}

		const storage = new StorageService();

		// Load and handle attachments before deleting the email itself
		if (email.hasAttachments) {
			const attachmentsForEmail = await db
				.select({
					attachmentId: attachments.id,
					storagePath: attachments.storagePath,
				})
				.from(emailAttachments)
				.innerJoin(attachments, eq(emailAttachments.attachmentId, attachments.id))
				.where(eq(emailAttachments.emailId, emailId));

			try {
				for (const attachment of attachmentsForEmail) {
					// Delete the link between this email and the attachment record.
					await db
						.delete(emailAttachments)
						.where(
							and(
								eq(emailAttachments.emailId, emailId),
								eq(emailAttachments.attachmentId, attachment.attachmentId)
							)
						);

					// Check if any other emails are linked to this attachment record.
					const [recordRefCount] = await db
						.select({ count: count() })
						.from(emailAttachments)
						.where(eq(emailAttachments.attachmentId, attachment.attachmentId));

					// If no other emails are linked to this record, it's safe to delete it and the file.
					if (recordRefCount.count === 0) {
						await storage.delete(attachment.storagePath);
						await db
							.delete(attachments)
							.where(eq(attachments.id, attachment.attachmentId));
					}
				}
			} catch (error) {
				logger.error(
					{
						emailId,
						error: error instanceof Error ? error.message : String(error),
					},
					'Failed to delete email attachments'
				);
				throw new Error('Failed to delete email attachments');
			}
		}

		// Delete the email file from storage
		await storage.delete(email.storagePath);

		const searchService = new SearchService();
		await searchService.deleteDocuments('emails', [emailId]);

		await db.delete(archivedEmails).where(eq(archivedEmails.id, emailId));

		// Build audit details: system-initiated deletions carry retention context
		// for GoBD compliance; manual deletions record only the reason.
		const auditDetails: Record<string, unknown> = {
			reason: options.systemDelete ? 'RetentionExpiration' : 'ManualDeletion',
		};
		if (options.systemDelete && options.governingRule) {
			auditDetails.governingRule = options.governingRule;
		}

		await this.auditService.createAuditLog({
			actorIdentifier: actor.id,
			actionType: 'DELETE',
			targetType: 'ArchivedEmail',
			targetId: emailId,
			actorIp,
			details: auditDetails,
		});
	}
}
