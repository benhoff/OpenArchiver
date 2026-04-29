# Outlook COM Push Import

Use this source when you cannot get Microsoft 365 tenant permissions for Graph API access, but you can run classic Outlook for Windows under the mailbox user.

This importer has three parts:

1. An `outlook_com` ingestion source in OpenArchiver.
2. A Windows PowerShell agent that reads mail through Outlook COM.
3. Server-side check and bulk import endpoints that avoid duplicate uploads.

## Requirements

- Classic Outlook for Windows installed and configured with the mailbox.
- Outlook must be able to sync the folders you want to archive.
- An OpenArchiver API key for a user with `sync:ingestion` permission.
- Backend `API_REQUEST_BODY_LIMIT` large enough for your upload batches.

New Outlook for Windows does not expose the classic Outlook COM object model.

## Create the Ingestion Source

Create an ingestion source in the UI and select **Outlook COM Push**, or create it through the API:

```json
{
	"name": "My Outlook COM Archive",
	"provider": "outlook_com",
	"providerConfig": {
		"type": "outlook_com",
		"mailboxEmail": "user@example.com"
	},
	"preserveOriginalFile": true
}
```

Keep the returned source ID. The PowerShell agent needs it.

## Backfill

Run this once to import historical mail. `-BackfillDaysBack 0` scans all available messages in the selected folders.
Subfolders are included by default; pass `-IncludeSubfolders $false` to limit the scan to only the named folders.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\outlook-com-importer.ps1 `
  -OpenArchiverUrl "https://archive.example.com" `
  -ApiBasePath "/v1" `
  -SourceId "00000000-0000-0000-0000-000000000000" `
  -ApiKey "YOUR_API_KEY" `
  -MailboxEmail "user@example.com" `
  -Mode Backfill `
  -Folders @("Inbox", "Sent Items") `
  -BackfillDaysBack 0
```

## Daily Reconciliation

Run this from Windows Task Scheduler once per day to check for missed mail:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\outlook-com-importer.ps1 `
  -OpenArchiverUrl "https://archive.example.com" `
  -ApiBasePath "/v1" `
  -SourceId "00000000-0000-0000-0000-000000000000" `
  -ApiKey "YOUR_API_KEY" `
  -MailboxEmail "user@example.com" `
  -Mode Reconcile `
  -ReconcileDaysBack 30
```

Set `-ReconcileDaysBack 0` for a full-mailbox daily check, but expect it to take longer on large mailboxes.

## Periodic Import

Run daemon mode when you want near-real-time capture without Microsoft Graph subscriptions:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\outlook-com-importer.ps1 `
  -OpenArchiverUrl "https://archive.example.com" `
  -ApiBasePath "/v1" `
  -SourceId "00000000-0000-0000-0000-000000000000" `
  -ApiKey "YOUR_API_KEY" `
  -MailboxEmail "user@example.com" `
  -Mode Daemon `
  -PollSeconds 300 `
  -RecentDaysBack 3 `
  -ReconcileDaysBack 30 `
  -DailyReconcileHour 2
```

Daemon mode scans recent mail every `PollSeconds` and runs one daily reconciliation scan after `DailyReconcileHour`.

Use `-ApiBasePath "/api/v1"` if the Windows agent reaches OpenArchiver through the SvelteKit frontend proxy instead of the backend service directly.

## Repair Unknown Senders

If older Outlook COM imports produced `unknown@outlook.local`, update OpenArchiver and rerun the agent in sender-repair mode. This scans Outlook again, matches existing archived rows by Outlook message identifiers, updates only archived emails whose sender is still unknown, and queues those emails for search reindexing.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\outlook-com-importer.ps1 `
  -OpenArchiverUrl "https://archive.example.com" `
  -ApiBasePath "/v1" `
  -SourceId "00000000-0000-0000-0000-000000000000" `
  -ApiKey "YOUR_API_KEY" `
  -MailboxEmail "user@example.com" `
  -Mode RepairSenders `
  -Folders @("Inbox", "Sent Items") `
  -BackfillDaysBack 0
```

Use the same `-Folders`, `-MailboxEmail`, and `-ApiBasePath` values that were used for the original import. `-BackfillDaysBack 0` scans all available messages; set a positive value to repair only recent messages.

## Duplicate Detection

The agent sends fingerprints first, then uploads only missing messages. OpenArchiver checks:

- Outlook provider ID derived from StoreID and EntryID.
- RFC `Message-ID`.
- SHA-256 of generated EML content when available.

The server also runs the normal archive-level deduplication during import.

The agent tags imported mail with `outlook-direction:received`, `outlook-direction:sent`, or `outlook-direction:outgoing`. Sent folders use Outlook's `SentOn` timestamp; received folders use `ReceivedTime`.

## Limitations

Outlook COM does not reliably expose the original RFC822 MIME payload. The agent builds an EML representation from Outlook properties, body content, and attachments. Use Microsoft 365 Graph or SMTP journaling when you need provider-original MIME preservation.
