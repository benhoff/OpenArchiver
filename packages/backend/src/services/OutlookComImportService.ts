import { and, eq, inArray, or, type SQL } from 'drizzle-orm';
import { createHash } from 'crypto';
import type {
	OutlookComBulkEmail,
	OutlookComBulkImportResult,
	OutlookComBulkResponse,
	OutlookComCheckResponse,
	OutlookComCheckResult,
	OutlookComEmailFingerprint,
	OutlookComSenderRepair,
	OutlookComSenderRepairResponse,
	OutlookComSenderRepairResult,
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
const MAX_SENDER_REPAIR_BATCH_SIZE = 1000;

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

const normalizeEmailAddress = (email?: string | null): string | undefined => {
	if (!email) return undefined;
	const match = email.trim().match(/[a-z0-9._%+\-']+@[a-z0-9.\-]+\.[a-z]{2,}/i);
	return match?.[0];
};

const mailboxEmailFromFolderPath = (folderPath?: string): string | undefined => {
	if (!folderPath) return undefined;
	return folderPath
		.replaceAll('\\', '/')
		.split('/')
		.map((segment) => normalizeEmailAddress(segment))
		.find((email): email is string => !!email);
};

const isOutlookComSentFolder = (folderPath?: string): boolean => {
	if (!folderPath) return false;
	const normalized = folderPath.replaceAll('\\', '/').toLowerCase();
	return /(^|\/)(sent|sent items|sent mail|outbox|drafts)(\/|$)/.test(normalized);
};

const isOutlookComSentMessage = (message: OutlookComBulkEmail): boolean =>
	(message.tags || []).some(
		(tag) => tag === 'outlook-direction:sent' || tag === 'outlook-direction:outgoing'
	) || isOutlookComSentFolder(message.folderPath);

const isUnknownOutlookSender = (email?: string): boolean =>
	!email || email.toLowerCase() === 'unknown@outlook.local' || email === 'No Sender';

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
				const mailboxEmail =
					normalizeEmailAddress(message.mailboxEmail) ||
					(source.credentials.type === 'outlook_com'
						? normalizeEmailAddress(source.credentials.mailboxEmail)
						: undefined) ||
					mailboxEmailFromFolderPath(message.folderPath);
				const userEmail =
					mailboxEmail ||
					parsedForMessageId.userEmail ||
					'outlook-com.local';
				parsedForMessageId.userEmail = userEmail;
				parsedForMessageId.path = normalizeFolderPath(message.folderPath);
				parsedForMessageId.tags = message.tags;
				if (
					mailboxEmail &&
					isOutlookComSentMessage(message) &&
					isUnknownOutlookSender(parsedForMessageId.from[0]?.address)
				) {
					const currentFrom = parsedForMessageId.from[0];
					parsedForMessageId.from[0] = {
						name: currentFrom?.name || '',
						address: mailboxEmail,
					};
				}

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

	public static async repairSenders(
		ingestionSourceId: string,
		messages: OutlookComSenderRepair[]
	): Promise<OutlookComSenderRepairResponse> {
		if (!Array.isArray(messages)) {
			throw new Error('messages must be an array.');
		}
		if (messages.length > MAX_SENDER_REPAIR_BATCH_SIZE) {
			throw new Error(`messages cannot contain more than ${MAX_SENDER_REPAIR_BATCH_SIZE} items.`);
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

		for (const message of messages) {
			if (message.providerMessageId) providerIds.add(message.providerMessageId);
			const rawOutlookProviderId = outlookProviderIdFromRawIds(message);
			if (rawOutlookProviderId) providerIds.add(rawOutlookProviderId);
			for (const candidate of normalizeMessageIdCandidates(
				message.internetMessageId || message.messageIdHeader
			)) {
				messageIds.add(candidate);
			}
		}

		const matchConditions: SQL[] = [];
		if (providerIds.size > 0) {
			matchConditions.push(inArray(archivedEmails.providerMessageId, Array.from(providerIds)));
		}
		if (messageIds.size > 0) {
			matchConditions.push(inArray(archivedEmails.messageIdHeader, Array.from(messageIds)));
		}

		const archived =
			matchConditions.length === 0
				? []
				: await db
						.select({
							id: archivedEmails.id,
							providerMessageId: archivedEmails.providerMessageId,
							messageIdHeader: archivedEmails.messageIdHeader,
							senderEmail: archivedEmails.senderEmail,
						})
						.from(archivedEmails)
						.where(and(sourceFilter, or(...matchConditions)));

		const byProviderId = new Map<string, (typeof archived)[number]>();
		const byMessageId = new Map<string, (typeof archived)[number]>();

		for (const email of archived) {
			if (email.providerMessageId) byProviderId.set(email.providerMessageId, email);
			if (email.messageIdHeader) {
				for (const candidate of normalizeMessageIdCandidates(email.messageIdHeader)) {
					byMessageId.set(candidate, email);
				}
			}
		}

		const results: OutlookComSenderRepairResult[] = [];
		const repairedIds: string[] = [];
		let repaired = 0;
		let skipped = 0;
		let notFound = 0;
		let failed = 0;

		for (const message of messages) {
			const clientId = fingerprintClientId(message);
			try {
				const providerCandidates = [
					message.providerMessageId,
					outlookProviderIdFromRawIds(message) || undefined,
				].filter((candidate): candidate is string => !!candidate);
				const messageCandidates = normalizeMessageIdCandidates(
					message.internetMessageId || message.messageIdHeader
				);

				const providerMatch = providerCandidates
					.map((candidate) => byProviderId.get(candidate))
					.find((email): email is (typeof archived)[number] => !!email);
				const messageMatch = messageCandidates
					.map((candidate) => byMessageId.get(candidate))
					.find((email): email is (typeof archived)[number] => !!email);
				const archivedEmail = providerMatch || messageMatch;

				if (!archivedEmail) {
					results.push({ clientId, status: 'not_found' });
					notFound += 1;
					continue;
				}

				const senderEmail = normalizeEmailAddress(message.senderEmail);
				if (!senderEmail || isUnknownOutlookSender(senderEmail)) {
					results.push({
						clientId,
						status: 'skipped',
						archivedEmailId: archivedEmail.id,
						message: 'No repaired SMTP sender address was supplied.',
					});
					skipped += 1;
					continue;
				}

				if (!isUnknownOutlookSender(archivedEmail.senderEmail)) {
					results.push({
						clientId,
						status: 'skipped',
						archivedEmailId: archivedEmail.id,
						message: 'Archived sender is already populated.',
					});
					skipped += 1;
					continue;
				}

				await db
					.update(archivedEmails)
					.set({
						senderName: message.senderName || null,
						senderEmail,
					})
					.where(eq(archivedEmails.id, archivedEmail.id));

				repairedIds.push(archivedEmail.id);
				results.push({
					clientId,
					status: 'repaired',
					archivedEmailId: archivedEmail.id,
				});
				repaired += 1;
			} catch (error) {
				results.push({
					clientId,
					status: 'failed',
					message: error instanceof Error ? error.message : String(error),
				});
				failed += 1;
			}
		}

		if (repairedIds.length > 0) {
			await indexingQueue.add('index-email-batch', {
				emails: repairedIds.map((archivedEmailId) => ({ archivedEmailId })),
			});
		}

		return {
			repaired,
			skipped,
			notFound,
			failed,
			results,
		};
	}
}
