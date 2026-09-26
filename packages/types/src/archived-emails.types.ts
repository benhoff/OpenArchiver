/**
 * Represents a single recipient of an email.
 */
export interface Recipient {
	name?: string;
	email: string;
}

/**
 * Represents a single attachment of an email.
 */
export interface Attachment {
	id: string;
	filename: string;
	mimeType: string | null;
	sizeBytes: number;
	storagePath: string;
}

export interface ThreadEmail {
	id: string; //the archivedemail id
	subject: string | null;
	sentAt: Date;
	senderEmail: string;
}

/**
 * Represents a single archived email.
 */
export interface ArchivedEmail {
	id: string;
	ingestionSourceId: string;
	userEmail: string;
	messageIdHeader: string | null;
	sentAt: Date;
	subject: string | null;
	senderName: string | null;
	senderEmail: string;
	recipients: Recipient[];
	storagePath: string;
	storageHashSha256: string;
	sizeBytes: number;
	isIndexed: boolean;
	hasAttachments: boolean;
	isOnLegalHold: boolean;
	isJournaled: boolean | null;
	archivedAt: Date;
	attachments?: Attachment[];
	raw?: Buffer;
	thread?: ThreadEmail[];
	path: string | null;
	tags: string[] | null;
}

/**
 * Represents a paginated list of archived emails.
 */
export interface PaginatedArchivedEmails {
	items: ArchivedEmail[];
	total: number;
	page: number;
	limit: number;
}

/**
 * Lightweight archived-email metadata returned by the read-only message feed.
 * Large storage fields and raw EML bytes are intentionally omitted.
 */
export interface ArchivedEmailFeedItem {
	id: string;
	threadId: string | null;
	ingestionSourceId: string;
	userEmail: string;
	messageIdHeader: string | null;
	providerMessageId: string | null;
	sentAt: Date;
	subject: string | null;
	senderName: string | null;
	senderEmail: string;
	recipients: Recipient[];
	hasAttachments: boolean;
	archivedAt: Date;
	path: string | null;
	tags: string[] | null;
}

/** A cursor-paginated, newest-first page from the archived-email feed. */
export interface ArchivedEmailFeedResponse {
	items: ArchivedEmailFeedItem[];
	nextCursor: string | null;
	hasMore: boolean;
}

/**
 * A page of newly archived emails in transactional change-log order.
 * The checkpoint is always returned, including when no new items are available.
 */
export interface ArchivedEmailChangesResponse {
	items: ArchivedEmailFeedItem[];
	nextCursor: string;
	hasMore: boolean;
}

/** A normalized email address in parsed archived-email content. */
export interface ArchivedEmailContentAddress {
	name: string | null;
	email: string;
}

/** Attachment metadata returned with parsed content. Attachment bytes are omitted. */
export interface ArchivedEmailContentAttachment {
	filename: string | null;
	contentType: string;
	size: number;
	contentId: string | null;
	inline: boolean;
}

/** Structured content parsed from one archived RFC822/EML message. */
export interface ArchivedEmailContent {
	id: string;
	subject: string | null;
	sentAt: Date;
	messageId: string | null;
	inReplyTo: string | null;
	from: ArchivedEmailContentAddress[];
	to: ArchivedEmailContentAddress[];
	cc: ArchivedEmailContentAddress[];
	bcc: ArchivedEmailContentAddress[];
	replyTo: ArchivedEmailContentAddress[];
	text: string | null;
	html: string | null;
	attachments: ArchivedEmailContentAttachment[];
}
