import type { EmailObject, MailboxUser, OutlookComCredentials, SyncState } from '@open-archiver/types';
import type { IEmailConnector } from '../EmailProviderFactory';

/**
 * Client-push source for the Windows Outlook COM agent.
 *
 * The local agent uploads generated EML payloads through the ingestion API, so there is no
 * provider-side mailbox to poll from the backend worker.
 */
export class OutlookComConnector implements IEmailConnector {
	constructor(private credentials: OutlookComCredentials) {}

	public async testConnection(): Promise<boolean> {
		return true;
	}

	public async *listAllUsers(): AsyncGenerator<MailboxUser> {
		return;
	}

	public async *fetchEmails(): AsyncGenerator<EmailObject | null> {
		return;
	}

	public getUpdatedSyncState(): SyncState {
		return {};
	}
}
