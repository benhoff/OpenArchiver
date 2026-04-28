import { and, eq, inArray, or, type SQL } from 'drizzle-orm';
import { createHash } from 'crypto';
import type {
	OutlookComBulkEmail,
	OutlookComBulkImportResult,
	OutlookComBulkResponse,
	OutlookComCheckResponse,
	OutlookComCheckResult,
	OutlookComEmailFingerprint,
} from '@open-archiver/types';
import { db } from '../database';
import { archivedEmails } from '../database/schema';
import { IngestionService } from './IngestionService';
import { StorageService } from './StorageService';
import { indexingQueue } from '../jobs/queues';
import { parseEmlToEmailObject } from '../helpers/parseEmlToEmailObject';
import { logger } from '../config/logger';

const MAX_CHECK_BATCH_SIZE = 1000;
const MAX_IMPORT_BATCH_SIZE = 100;

const fingerprintClientId = (fingerprint: OutlookComEmailFingerprint): string =>
	fingerprint.clientId ||
	fingerprint.providerMessageId ||
	fingerprint.internetMessageId ||
	fingerprint.messageIdHeader ||
	fingerprint.contentHashSha256 ||
	fingerprint.outlookEntryId ||
	'unknown';

const normalizeMessageIdCandidates = (messageId?: string): string[] => {
	if (!messageId) return [];
	const trimmed = messageId.trim();
	if (!trimmed) return [];

	const withoutAngles =
		trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed.slice(1, -1).trim() : trimmed;
	const withAngles = withoutAngles ? `<${withoutAngles}>` : '';

	return Array.from(new Set([trimmed, withoutAngles, withAngles].filter(Boolean)));
};

const normalizeFolderPath = (folderPath?: string): string | undefined => {
	if (!folderPath) return undefined;
	const normalized = folderPath
		.replaceAll('\\', '/')
		.split('/')
		.map((segment) => segment.trim().replace(/[^a-zA-Z0-9 .@_-]/g, '_'))
		.filter((segment) => segment && segment !== '.' && segment !== '..')
		.join('/');
	return normalized ? `${normalized}/` : undefined;
};

const normalizeProviderIdForStorage = (providerId?: string): string | undefined => {
	if (!providerId) return undefined;
	const normalized = providerId.trim().replace(/[^a-zA-Z0-9._@-]/g, '_');
	return normalized || undefined;
};

const outlookProviderIdFromRawIds = (fingerprint: OutlookComEmailFingerprint): string | null => {
	if (!fingerprint.outlookEntryId || !fingerprint.storeId) return null;
	const internetMessageId = fingerprint.internetMessageId || fingerprint.messageIdHeader || '';
	const seed = `${fingerprint.storeId}|${fingerprint.outlookEntryId}|${internetMessageId}`;
	return `outlook-com-${createHash('sha256').update(seed).digest('hex')}`;
};

export class OutlookComImportService {
	public static async checkMessages(
		ingestionSourceId: string,
		fingerprints: OutlookComEmailFingerprint[]
	): Promise<OutlookComCheckResponse> {
		if (!Array.isArray(fingerprints)) {
			throw new Error('messages must be an array.');
		}
		if (fingerprints.length > MAX_CHECK_BATCH_SIZE) {
			throw new Error(`messages cannot contain more than ${MAX_CHECK_BATCH_SIZE} items.`);
		}

		const source = await IngestionService.findById(ingestionSourceId);
		if (source.provider !== 'outlook_com') {
			throw new Error('This endpoint only accepts outlook_com ingestion sources.');
		}

		const groupIds = await IngestionService.findGroupSourceIds(ingestionSourceId);
		const sourceFilter =
			groupIds.length === 1
				? eq(archivedEmails.ingestionSourceId, groupIds[0])
				: inArray(archivedEmails.ingestionSourceId, groupIds);

		const providerIds = new Set<string>();
		const messageIds = new Set<string>();
		const contentHashes = new Set<string>();

		for (const fingerprint of fingerprints) {
			if (fingerprint.providerMessageId) providerIds.add(fingerprint.providerMessageId);
			const rawOutlookProviderId = outlookProviderIdFromRawIds(fingerprint);
			if (rawOutlookProviderId) providerIds.add(rawOutlookProviderId);
			for (const candidate of normalizeMessageIdCandidates(
				fingerprint.internetMessageId || fingerprint.messageIdHeader
			)) {
				messageIds.add(candidate);
			}
			if (fingerprint.contentHashSha256) {
				contentHashes.add(fingerprint.contentHashSha256.toLowerCase());
			}
		}

		const matchConditions: SQL[] = [];
		if (providerIds.size > 0) {
			matchConditions.push(inArray(archivedEmails.providerMessageId, Array.from(providerIds)));
		}
		if (messageIds.size > 0) {
			matchConditions.push(inArray(archivedEmails.messageIdHeader, Array.from(messageIds)));
		}
		if (contentHashes.size > 0) {
			matchConditions.push(
				inArray(archivedEmails.storageHashSha256, Array.from(contentHashes))
			);
		}

		const archived =
			matchConditions.length === 0
				? []
				: await db
						.select({
							id: archivedEmails.id,
							providerMessageId: archivedEmails.providerMessageId,
							messageIdHeader: archivedEmails.messageIdHeader,
							storageHashSha256: archivedEmails.storageHashSha256,
						})
						.from(archivedEmails)
						.where(and(sourceFilter, or(...matchConditions)));

		const byProviderId = new Map<string, string>();
		const byMessageId = new Map<string, string>();
		const byContentHash = new Map<string, string>();

		for (const email of archived) {
			if (email.providerMessageId) byProviderId.set(email.providerMessageId, email.id);
			if (email.messageIdHeader) {
				for (const candidate of normalizeMessageIdCandidates(email.messageIdHeader)) {
					byMessageId.set(candidate, email.id);
				}
			}
			if (email.storageHashSha256) {
				byContentHash.set(email.storageHashSha256.toLowerCase(), email.id);
			}
		}

		const results: OutlookComCheckResult[] = fingerprints.map((fingerprint) => {
			const clientId = fingerprintClientId(fingerprint);
			const providerCandidates = [
				fingerprint.providerMessageId,
				outlookProviderIdFromRawIds(fingerprint) || undefined,
			].filter((candidate): candidate is string => !!candidate);
			const messageCandidates = normalizeMessageIdCandidates(
				fingerprint.internetMessageId || fingerprint.messageIdHeader
			);
			const contentHash = fingerprint.contentHashSha256?.toLowerCase();

			const providerMatch = providerCandidates.find((candidate) =>
				byProviderId.has(candidate)
			);
			if (providerMatch) {
				return {
					clientId,
					exists: true,
					archivedEmailId: byProviderId.get(providerMatch),
					matchedBy: 'providerMessageId',
				};
			}

			const messageMatch = messageCandidates.find((candidate) => byMessageId.has(candidate));
			if (messageMatch) {
				return {
					clientId,
					exists: true,
					archivedEmailId: byMessageId.get(messageMatch),
					matchedBy: 'messageIdHeader',
				};
			}

			if (contentHash && byContentHash.has(contentHash)) {
				return {
					clientId,
					exists: true,
					archivedEmailId: byContentHash.get(contentHash),
					matchedBy: 'contentHashSha256',
				};
			}

			return { clientId, exists: false };
		});

		return {
			results,
			existing: results.filter((result) => result.exists).map((result) => result.clientId),
			missing: results.filter((result) => !result.exists).map((result) => result.clientId),
		};
	}

	public static async importBulk(
		ingestionSourceId: string,
		messages: OutlookComBulkEmail[]
	): Promise<OutlookComBulkResponse> {
		if (!Array.isArray(messages)) {
			throw new Error('messages must be an array.');
		}
		if (messages.length > MAX_IMPORT_BATCH_SIZE) {
			throw new Error(`messages cannot contain more than ${MAX_IMPORT_BATCH_SIZE} items.`);
		}

		const source = await IngestionService.findById(ingestionSourceId);
		if (source.provider !== 'outlook_com') {
			throw new Error('This endpoint only accepts outlook_com ingestion sources.');
		}
		if (source.status === 'paused') {
			throw new Error('This ingestion source is paused.');
		}

		await IngestionService.update(ingestionSourceId, {
			status: 'active',
			lastSyncStartedAt: new Date(),
			lastSyncStatusMessage: 'Receiving Outlook COM import batch...',
		});

		const precheck = await this.checkMessages(ingestionSourceId, messages);
		const existingIds = new Set(precheck.existing);
		const storage = new StorageService();
		const ingestionService = new IngestionService();
		const results: OutlookComBulkImportResult[] = [];
		let imported = 0;
		let existing = 0;
		let failed = 0;

		for (const message of messages) {
			const clientId = fingerprintClientId(message);
			if (existingIds.has(clientId)) {
				const existingResult = precheck.results.find((result) => result.clientId === clientId);
				results.push({
					clientId,
					status: 'existing',
					archivedEmailId: existingResult?.archivedEmailId,
				});
				existing += 1;
				continue;
			}

			try {
				if (!message.emlBase64) {
					throw new Error('emlBase64 is required.');
				}

				const emlBuffer = Buffer.from(message.emlBase64, 'base64');
				if (emlBuffer.length === 0) {
					throw new Error('Decoded EML payload is empty.');
				}

				const parsedForMessageId = await parseEmlToEmailObject(emlBuffer, {
					preserveOriginalFile: source.preserveOriginalFile,
				});
				const hasMessageId = !!parsedForMessageId.headers.get('message-id');
				const providerId = hasMessageId
					? message.providerMessageId || message.clientId || parsedForMessageId.id
					: message.contentHashSha256 || message.providerMessageId || message.clientId;

				parsedForMessageId.id =
					normalizeProviderIdForStorage(providerId) || parsedForMessageId.id;
				const userEmail =
					message.mailboxEmail ||
					(source.credentials.type === 'outlook_com'
						? source.credentials.mailboxEmail
						: undefined) ||
					parsedForMessageId.userEmail ||
					'outlook-com.local';
				parsedForMessageId.userEmail = userEmail;
				parsedForMessageId.path = normalizeFolderPath(message.folderPath);
				parsedForMessageId.tags = message.tags;

				const processed = await ingestionService.processEmail(
					parsedForMessageId,
					source,
					storage,
					userEmail
				);

				if (processed) {
					await indexingQueue.add('index-email-batch', { emails: [processed] });
					results.push({
						clientId,
						status: 'imported',
						archivedEmailId: processed.archivedEmailId,
					});
					imported += 1;
				} else {
					results.push({
						clientId,
						status: 'existing',
						message: 'Skipped by archive deduplication.',
					});
					existing += 1;
				}
			} catch (error) {
				const messageText = error instanceof Error ? error.message : String(error);
				logger.error({ err: error, ingestionSourceId, clientId }, 'Outlook COM import failed');
				results.push({ clientId, status: 'failed', message: messageText });
				failed += 1;
			}
		}

		await IngestionService.update(ingestionSourceId, {
			status: failed > 0 && imported === 0 ? 'error' : 'active',
			lastSyncFinishedAt: new Date(),
			lastSyncStatusMessage: `Outlook COM import batch complete. Imported ${imported}, existing ${existing}, failed ${failed}.`,
		});

		return { imported, existing, failed, results };
	}
}
