import { createHash } from 'crypto';
import type { AddressObject, Attachment, ParsedMail } from 'mailparser';
import { simpleParser } from 'mailparser';
import type { EmailAddress, EmailObject } from '@open-archiver/types';
import { getThreadId } from '../services/ingestion-connectors/helpers/utils';
import { writeEmailToTempFile } from '../services/ingestion-connectors/helpers/tempFile';

export interface ParseEmlOptions {
	id?: string;
	userEmail?: string;
	path?: string;
	tags?: string[];
	preserveOriginalFile?: boolean;
}

const mapAddresses = (addresses: AddressObject | AddressObject[] | undefined): EmailAddress[] => {
	if (!addresses) return [];
	const addressArray = Array.isArray(addresses) ? addresses : [addresses];
	return addressArray.flatMap((a) =>
		a.value.map((v) => ({
			name: v.name,
			address: v.address?.replaceAll(`'`, '') || '',
		}))
	);
};

export async function parseEmlToEmailObject(
	emlBuffer: Buffer,
	options: ParseEmlOptions = {}
): Promise<EmailObject> {
	const tempFilePath = await writeEmailToTempFile(emlBuffer);
	const parsedEmail: ParsedMail = await simpleParser(emlBuffer);
	const messageId =
		options.id ||
		parsedEmail.messageId ||
		`generated-${createHash('sha256').update(emlBuffer).digest('hex')}`;

	const attachments = parsedEmail.attachments.map((attachment: Attachment) => ({
		filename: attachment.filename || 'untitled',
		contentType: attachment.contentType,
		size: attachment.size,
		content: options.preserveOriginalFile ? Buffer.alloc(0) : (attachment.content as Buffer),
	}));

	const from = mapAddresses(parsedEmail.from);
	if (from.length === 0) {
		from.push({ name: 'No Sender', address: 'No Sender' });
	}

	return {
		id: messageId,
		threadId: getThreadId(parsedEmail.headers),
		from,
		to: mapAddresses(parsedEmail.to),
		cc: mapAddresses(parsedEmail.cc),
		bcc: mapAddresses(parsedEmail.bcc),
		subject: parsedEmail.subject || '',
		body: parsedEmail.text || '',
		html: parsedEmail.html || '',
		headers: parsedEmail.headers,
		attachments,
		receivedAt: parsedEmail.date || new Date(),
		tempFilePath,
		userEmail: options.userEmail,
		path: options.path,
		tags: options.tags,
	};
}
