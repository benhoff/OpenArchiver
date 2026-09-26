# Read-Only Email Overlay Integration Specification

Status: API implemented. Apply database migrations through `0040_archived_email_change_log` before deploying this version.

This document is the standalone implementation contract for adding a read-only OpenArchiver email overlay to a Qt desktop application. It covers the server API, client behavior, security boundaries, UI state, popup ownership, ArcX integration, configuration, testing, and rollout. No other OpenArchiver documentation is required to implement this scope.

## 1. Scope and v1 Decisions

The v1 overlay is a flat message browser:

- Open the most recent messages in one configured archive path.
- Page backward through older messages.
- Open one message and display safe plain text.
- Optionally poll for newly archived messages in the background.
- Display attachment metadata only.
- Keep the overlay local to the HUD composition path so it is not included in recordings or outgoing display streams.

The following are deliberately out of scope:

- Sending, replying, forwarding, drafting, or changing mailbox state.
- Downloading attachment bytes.
- A reliable unread/read state. OpenArchiver does not expose one through these endpoints.
- A complete thread view. Feed items contain a nullable `threadId`, but the API does not provide a complete paginated thread contract.
- Rendering remote HTML, loading remote images, or executing message content.
- Push notifications, webhooks, Server-Sent Events, or WebSockets.

For ArcX, v1 registers `open_email_overlay` as a configurable action and does not replace an existing default control. A combined SMS/email chooser can be added later without changing the API client.

Background polling is optional and disabled by default. If the overlay only needs fresh data when opened, fetch the normal feed on every open and do not run the changes poller.

## 2. Service and Authentication

Production base URL:

```text
https://mail.home.benhoff.net/api/v1
```

All requests described here are read-only `GET` requests. Authenticate with an OpenArchiver API key owned by a user with `read:archive` permission:

```http
X-API-Key: YOUR_API_KEY
Accept: application/json
```

Create the key in OpenArchiver under **Settings > API Keys**. The raw value is shown only when the key is created. Never place the key in a URL, query string, log message, crash report, status response, screenshot, or non-secret settings store.

The public URL above uses the OpenArchiver frontend proxy, so its API path begins with `/api/v1`. A client connecting directly to the backend service would use `/v1`; the production overlay should use the public HTTPS URL.

TLS certificate verification must remain enabled. Production configuration must reject non-HTTPS base URLs. Local development may explicitly allow loopback HTTP.

## 3. Common Data Contract

Clients must ignore unknown JSON properties so the server can add fields compatibly. Treat every identifier and cursor as an opaque string. Date-time fields are JSON strings in ISO 8601/RFC 3339 form and must be parsed as absolute instants.

### Email summary

The normal feed and changes feed return the same summary object:

```text
EmailSummary
  id: string (UUID, required)
  threadId: string | null (required)
  ingestionSourceId: string (UUID, required)
  userEmail: string (required)
  messageIdHeader: string | null (required)
  providerMessageId: string | null (required)
  sentAt: date-time string (required)
  subject: string | null (required)
  senderName: string | null (required)
  senderEmail: string (required)
  recipients: Recipient[] (required)
  hasAttachments: boolean (required)
  archivedAt: date-time string (required)
  path: string | null (required)
  tags: string[] | null (required)

Recipient
  email: string (required)
  name: string (optional)
```

Representative summary fixture:

```json
{
	"id": "2ae68a90-2a99-4c42-986f-519640fef621",
	"threadId": "provider-thread-123",
	"ingestionSourceId": "f067dfb1-eb87-4462-8f16-4428e20f24f1",
	"userEmail": "person@example.com",
	"messageIdHeader": "<example-message@example.com>",
	"providerMessageId": "provider-message-456",
	"sentAt": "2026-09-02T06:30:00.000Z",
	"subject": "Example message",
	"senderName": "Example Sender",
	"senderEmail": "sender@example.net",
	"recipients": [
		{
			"name": "Example Recipient",
			"email": "person@example.com"
		}
	],
	"hasAttachments": true,
	"archivedAt": "2026-09-02T06:31:04.123Z",
	"path": "person@example.com/Inbox/",
	"tags": ["outlook-direction:received"]
}
```

Do not infer unread state from `archivedAt`, tags, list position, or whether the overlay has displayed the message. A client may maintain a local “viewed in this application” state, but it must not present that as mailbox unread state.

## 4. Recent-Message Feed

### Request

```http
GET /archived-emails?path=ben.hoff%40skan.ai%2FInbox%2F&limit=25
X-API-Key: YOUR_API_KEY
Accept: application/json
```

Query parameters:

| Parameter           | Required | Contract                                                                               |
| ------------------- | -------- | -------------------------------------------------------------------------------------- |
| `path`              | No       | Exact archive-path match. Case and trailing slash are significant. Maximum 4096 chars. |
| `ingestionSourceId` | No       | UUID. Restricts results to that source and its configured merge group.                 |
| `limit`             | No       | Integer from 1 through 100. Default is 25.                                             |
| `cursor`            | No       | Opaque `nextCursor` from the preceding page, with the same logical filters.            |

Always construct query parameters with `QUrlQuery` or another URL encoder. Do not concatenate mailbox paths into a URL manually.

### Response

Results are ordered newest-first by `(sentAt, id)`:

```json
{
	"items": [
		{
			"id": "2ae68a90-2a99-4c42-986f-519640fef621",
			"threadId": null,
			"ingestionSourceId": "f067dfb1-eb87-4462-8f16-4428e20f24f1",
			"userEmail": "person@example.com",
			"messageIdHeader": "<example-message@example.com>",
			"providerMessageId": "provider-message-456",
			"sentAt": "2026-09-02T06:30:00.000Z",
			"subject": "Example message",
			"senderName": "Example Sender",
			"senderEmail": "sender@example.net",
			"recipients": [{ "email": "person@example.com" }],
			"hasAttachments": true,
			"archivedAt": "2026-09-02T06:31:04.123Z",
			"path": "person@example.com/Inbox/",
			"tags": null
		}
	],
	"nextCursor": "OPAQUE_HISTORY_CURSOR",
	"hasMore": true
}
```

`nextCursor` is a string when another page exists and is `null` at the end. When `hasMore` is true, pass `nextCursor` as `cursor` to load the next older page. Do not decode, edit, sort, compare, or synthesize cursors.

The client should deduplicate accumulated list entries by `id` as a defensive measure. A newly opened overlay should make a fresh request without a history cursor, replace its current list, and cancel or ignore any older list generation.

## 5. Selected-Message Content

Use this endpoint instead of the full archived-record endpoint:

```http
GET /archived-emails/2ae68a90-2a99-4c42-986f-519640fef621/content
X-API-Key: YOUR_API_KEY
Accept: application/json
```

The `id` path component must be a UUID obtained from a feed response and must be URL-safe encoded.

### Content contract

```text
EmailContent
  id: string (UUID, required)
  subject: string | null (required)
  sentAt: date-time string (required)
  messageId: string | null (required)
  inReplyTo: string | null (required)
  from: ContentAddress[] (required)
  to: ContentAddress[] (required)
  cc: ContentAddress[] (required)
  bcc: ContentAddress[] (required)
  replyTo: ContentAddress[] (required)
  text: string | null (required)
  html: string | null (required)
  attachments: ContentAttachment[] (required)

ContentAddress
  name: string | null (required)
  email: string (required)

ContentAttachment
  filename: string | null (required)
  contentType: string (required)
  size: integer bytes (required)
  contentId: string | null (required)
  inline: boolean (required)
```

Representative content fixture:

```json
{
	"id": "2ae68a90-2a99-4c42-986f-519640fef621",
	"subject": "Example message",
	"sentAt": "2026-09-02T06:30:00.000Z",
	"messageId": "<example-message@example.com>",
	"inReplyTo": null,
	"from": [
		{
			"name": "Example Sender",
			"email": "sender@example.net"
		}
	],
	"to": [
		{
			"name": "Example Recipient",
			"email": "person@example.com"
		}
	],
	"cc": [],
	"bcc": [],
	"replyTo": [],
	"text": "This is the plain-text message body.",
	"html": "<p>This is the <strong>HTML</strong> message body.</p>",
	"attachments": [
		{
			"filename": "example.pdf",
			"contentType": "application/pdf",
			"size": 48123,
			"contentId": null,
			"inline": false
		}
	]
}
```

Display-body selection:

1. Prefer non-empty `text`.
2. If `text` is absent or blank and `html` is present, convert HTML to bounded plain text locally.
3. Otherwise display “No message body available.”

Never place message HTML in a browser view. Do not fetch `img`, CSS, font, link-preview, or other remote resources. Do not make URLs clickable by default. If `QTextDocument` is used only for HTML-to-text conversion, ensure it has no network-backed resource provider and never render the original document.

Attachment entries are informational. Do not present an active download or open control in v1.

The subject and parsed headers from `/content` may differ slightly from feed metadata because the content endpoint parses the stored EML. Use the content response while the detail view is open.

## 6. Incremental New-Mail Polling

Use this endpoint only for background “new archived mail” behavior:

```http
GET /archived-emails/changes?path=ben.hoff%40skan.ai%2FInbox%2F&limit=100
X-API-Key: YOUR_API_KEY
Accept: application/json
```

The changes feed uses a transactional change log in commit order. Concurrent inserts cannot commit a later checkpoint before an earlier one. This detects newly archived backfills whose original `sentAt` or `archivedAt` is old. It reports new archive rows, not mailbox unread transitions, updates, or deletions. Deleted rows are omitted. Changes to permissions, paths, or source merge groups do not replay previously archived rows; refresh the normal feed after such changes.

### Initialize

Omit `cursor` exactly once for a new authenticated user/filter scope. Initialization deliberately does not replay history:

```json
{
	"items": [],
	"nextCursor": "OPAQUE_CHANGE_CHECKPOINT",
	"hasMore": false
}
```

Persist `nextCursor` before scheduling the next poll.

Initialization skips already committed history and includes inserts still in flight when they commit. Existing timestamp-based cursors from the earlier implementation return `400`; clients must reinitialize polling and refresh the normal feed on upgrade. The change log starts when migration `0040` is applied; it does not backfill older archive rows.

The insertion trigger briefly serializes archive-writing transactions on one counter row. Keep these transactions short: a long-running archive writer delays other archive inserts until it commits or rolls back. Polls remain nonblocking reads. The counter is retained even if all messages are deleted.

### Poll

```http
GET /archived-emails/changes?path=ben.hoff%40skan.ai%2FInbox%2F&limit=100&cursor=OPAQUE_CHANGE_CHECKPOINT
X-API-Key: YOUR_API_KEY
Accept: application/json
```

Changes are returned in change-log order so they can be processed in order (timestamps can be out of order):

```json
{
	"items": [
		{
			"id": "2ae68a90-2a99-4c42-986f-519640fef621",
			"threadId": null,
			"ingestionSourceId": "f067dfb1-eb87-4462-8f16-4428e20f24f1",
			"userEmail": "person@example.com",
			"messageIdHeader": "<example-message@example.com>",
			"providerMessageId": "provider-message-456",
			"sentAt": "2026-09-02T06:30:00.000Z",
			"subject": "Example message",
			"senderName": "Example Sender",
			"senderEmail": "sender@example.net",
			"recipients": [{ "email": "person@example.com" }],
			"hasAttachments": false,
			"archivedAt": "2026-09-02T06:31:04.123Z",
			"path": "person@example.com/Inbox/",
			"tags": null
		}
	],
	"nextCursor": "OPAQUE_NEXT_CHANGE_CHECKPOINT",
	"hasMore": false
}
```

Polling algorithm:

```text
if no checkpoint exists:
    GET /changes without cursor
    require items to be an array
    atomically persist nextCursor
    schedule normal poll

on each poll:
    GET /changes with persisted cursor and unchanged filters
    validate the complete response
    process items in returned order, deduplicating by id
    atomically persist nextCursor even when items is empty
    if hasMore:
        poll again immediately with the new cursor
    else:
        wait configured poll interval
```

The default changes page size is 100 and the allowed range is 1–100. Use 100 unless memory constraints require less.

A changes cursor is bound to:

- The authenticated OpenArchiver user.
- The exact `path`, including case and trailing slash.
- The optional `ingestionSourceId`.

Reset the checkpoint whenever the API key, base URL, path, or ingestion source changes. A mismatched or malformed cursor produces HTTP `400`.

Recommended interval is 15–30 seconds. The server defaults to a rate limit of 100 requests per minute per client IP, so do not use rapid steady-state polling. Immediate draining while `hasMore` is true is expected.

Responses include `Cache-Control: no-store`. The client must not add its own response cache for feeds or content.

## 7. HTTP Client Requirements

Add an asynchronous `EmailArchiveClient` around the application's existing `QNetworkAccessManager` conventions.

Suggested interface:

```text
listMessages(filters, limit, cursor?, requestGeneration)
getMessageContent(messageId, requestGeneration)
initializeChanges(filters, requestGeneration)
pollChanges(filters, checkpoint, limit, requestGeneration)
cancelAll()
```

Each completion should return either a validated typed result or a typed error. Never expose raw response bodies through logs or generic status objects.

### Request lifecycle

- Set `X-API-Key` and `Accept: application/json` on every request.
- Use a finite request timeout. Recommended defaults are 10 seconds for feed polling and 15 seconds for content.
- Assign a monotonically increasing request generation whenever configuration changes, the overlay closes, or a new top-level load begins.
- Abort obsolete `QNetworkReply` objects where practical and ignore every completion whose generation is stale.
- A content response must also match the currently selected message ID before it updates the model.
- Use one in-flight changes poll at a time. Never overlap steady-state polls.
- On shutdown or disable, stop timers, abort replies, release popup ownership, clear textures, and clear in-memory message bodies.

### Redirect and URL policy

- Disable automatic redirects or use a manual redirect policy.
- Treat every 3xx response as an error. Do not forward the API key to a redirect target, even if the hostname appears related.
- Resolve endpoint paths only against the configured base URL.
- Reject base URLs containing credentials, fragments, or unexpected schemes.
- Do not copy the API key into an `Authorization` header, URL, or diagnostic context.

### Response limits and parsing

Recommended configurable limits:

| Response                 | Default maximum |
| ------------------------ | --------------- |
| Feed or changes response | 2 MiB           |
| Content response         | 16 MiB          |
| Displayed body text      | 250,000 chars   |
| Displayed subject        | 1,000 chars     |
| Displayed address label  | 1,000 chars     |

Enforce the byte limit while data is received, not only after buffering the full response. Abort when the limit is exceeded. Parse JSON with explicit type, required-field, numeric-range, and date validation. Reject the whole page if pagination fields are invalid; do not advance its cursor.

Preserve Unicode. Replace invalid display control characters, but do not silently rewrite identifiers, paths, or cursors.

### Retry policy

All three operations are `GET` and are safe to retry when no newer request generation exists.

- Do not retry `400`, `401`, `403`, or `404` automatically.
- For `429`, honor `Retry-After` when present.
- Retry network timeouts and HTTP `502`, `503`, and `504` with exponential backoff and jitter.
- A sensible interactive policy is two retries after approximately 500 ms and 1.5 seconds.
- A background poller should back off up to 60 seconds and return to the configured interval after a success.
- Do not retry indefinitely while the overlay is closing or configuration is changing.

## 8. Error Contract and UI Mapping

Error responses normally contain:

```json
{
	"message": "Human-readable error"
}
```

Rate-limit responses contain at least:

```json
{
	"status": 429,
	"message": "Too many requests from this IP, please try again later"
}
```

Map failures as follows:

| Condition             | Client behavior                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Network/TLS failure   | Show a generic unavailable error; retry only under the policy above.                                                          |
| `400` feed cursor     | Discard the history cursor and reload the newest page.                                                                        |
| `400` changes cursor  | Refresh the normal recent feed, initialize a new changes checkpoint, and report that background tracking was resynchronized.  |
| `401`                 | Stop requests and show “Email archive authentication failed.” Do not print the server body or key.                            |
| `403`                 | Stop requests and show “Email archive access is not permitted.”                                                               |
| `404` content         | Remove or disable the selected row and return to the list with “Message is no longer available.”                              |
| `429`                 | Respect `Retry-After`; keep the current model and checkpoint.                                                                 |
| `5xx`                 | Keep the current model, retry transient failures, and expose a generic service-unavailable state after retries are exhausted. |
| Invalid/oversize JSON | Keep the current model, do not advance a cursor, and expose a generic invalid-response error.                                 |

User-visible error strings must not include a sender, recipient, subject, body, attachment name, message ID, cursor, API key, or raw server response.

## 9. Model and Controller

Add an `EmailOverlayModel` and an `EmailOverlayController`, modeled on the application's SMS overlay but kept independent from SMS data and transport.

Required controller states:

```text
Hidden
MessageList
LoadingMessage
MessageDetail
Error
```

Recommended transitions:

```text
Hidden --open--> MessageList (start fresh feed request)
MessageList --select/open--> LoadingMessage
LoadingMessage --success--> MessageDetail
LoadingMessage --failure--> Error
MessageDetail --back--> MessageList
MessageList --back/timeout--> Hidden
Error --back--> previous safe state or Hidden
any visible state --disable/display removal/shutdown--> Hidden
```

List controls:

- Up/Down moves selection.
- Center or Right opens the selected message.
- Left closes the overlay.
- Moving beyond the last loaded row requests the next history cursor page when `hasMore` is true.
- While the next page is loading, retain the selection and current list.

Detail controls:

- Up/Down scrolls bounded plain text.
- Left returns to the existing list and selection.
- Do not expose reply, attachment-open, external-link, or HTML-mode controls.

Close after 60 seconds without overlay input by default. Network completions do not count as user activity. Reset the timer on recognized overlay navigation input.

When a background changes response contains new items, update any in-memory list by `id` and restore newest-first display order. Do not steal popup ownership or open the overlay automatically unless a separate future product requirement explicitly enables that behavior.

## 10. Popup-Slot Coordination

Before registering email as interactive, replace hard-coded popup precedence with a shared popup-slot coordinator.

Minimum ownership model:

```text
PopupOwner = None | Sms | Email

acquire(owner) -> granted/denied
release(owner)
currentOwner()
routeInput(inputEvent)
```

Required invariants:

- At most one of SMS and email is interactive at a time.
- Android notification presentation is suppressed whenever `currentOwner != None`.
- Notification suppression is derived from coordinator state; individual overlays do not independently toggle it.
- `release(owner)` is a no-op when the caller is not the current owner.
- Closing one overlay cannot unsuppress notifications while another owner exists.
- ArcX input is dispatched only to the current owner.
- Disable, display removal, timeout, and shutdown release ownership idempotently.

The integration project identified current hard-coded behavior near:

- `src/capture/video/StreamManagerKDE.cpp:1695`
- `src/capture/video/LinuxDmaBufWindow.cpp:2642`

Refactor those sites to consult the coordinator rather than adding a third hard-coded priority branch.

## 11. Renderer Integration and Privacy Boundary

Add the email texture builder alongside the existing SMS texture builder near `src/capture/video/LinuxDmaBufWindow.cpp:2839`.

Reuse the existing:

- Local overlay texture path.
- Shader and composition mechanism.
- HUD display target and anchoring behavior.
- Resource lifetime and render-thread synchronization conventions.

Acceptance requirement: sender, recipient, subject, body, and attachment metadata must appear only in the local HUD composition and must not appear in recordings, screenshots produced by the capture pipeline, or outgoing display streams.

Clear or overwrite textures when:

- The overlay closes.
- Email integration is disabled.
- The display is removed or changed.
- The renderer is recreated.
- The application shuts down.

Do not retain rendered message textures for later reuse after the model has been cleared.

## 12. ArcX Integration

Register a configurable action named:

```text
open_email_overlay
```

Integration locations supplied by the target project:

- Register the action near `src/ui/ArcXActionRegistry.cpp:3`.
- Wire it during startup near the SMS action in `src/core/main.cpp:1855`.
- Add it to the settings action dropdown.

Behavior:

1. If email integration is disabled or the API key is absent, reject the action without acquiring popup ownership.
2. Request the popup slot for `Email`.
3. If denied because SMS owns the slot, leave the current SMS overlay unchanged.
4. If granted, open the email list and fetch a fresh first page.
5. A second invocation while email owns the slot may close the overlay, matching the application's existing toggle convention.

Do not assign this action to a default ArcX control in v1.

## 13. Configuration and Secret Storage

Store the API key with QKeychain using:

```text
service: BackgroundRecorder
entry: EmailArchiveApiKey
```

Follow the QKeychain integration pattern already used by `src/network/AndroidNotificationReceiver.cpp:12`.

Secret precedence:

1. `BR_EMAIL_ARCHIVE_API_KEY` environment variable, when non-empty.
2. QKeychain entry.
3. Unconfigured.

When the environment override is active, settings may report that credentials are configured but must not display, copy, replace, persist, or clear the environment value.

Suggested non-secret configuration:

| Setting                               | Default                                |
| ------------------------------------- | -------------------------------------- |
| `email_archive_enabled`               | `false`                                |
| `email_archive_base_url`              | `https://mail.home.benhoff.net/api/v1` |
| `email_archive_path`                  | `ben.hoff@skan.ai/Inbox/`              |
| `email_archive_ingestion_source_id`   | empty                                  |
| `email_archive_page_size`             | `25`                                   |
| `email_archive_background_polling`    | `false`                                |
| `email_archive_poll_interval_seconds` | `20`                                   |
| `email_archive_inactivity_seconds`    | `60`                                   |
| `email_archive_request_timeout_ms`    | `10000`                                |

Validate page size as 1–100, changes polling interval as at least 15 seconds, and timeouts as finite positive values. Preserve the configured path exactly after rejecting empty values.

Settings actions:

- Replace API key.
- Clear API key.
- Test connection by requesting the first feed page with `limit=1`.

Status output may contain only non-sensitive health/configuration fields such as:

```json
{
	"enabled": true,
	"api_key_configured": true,
	"connected": true,
	"background_polling": false
}
```

Do not include the base URL query, path, source ID, cursor, sender, subject, recipient, body, attachment names, or raw errors in public status output.

## 14. Logging and Data Handling

Email data and credentials are sensitive. Production logs must not contain:

- API keys or authentication headers.
- Request URLs containing cursors or folder paths.
- Sender or recipient names/addresses.
- Subjects, bodies, tags, attachment names, message IDs, thread IDs, or provider IDs.
- Raw JSON responses or error response bodies.

Permitted operational fields include operation name, HTTP status class, duration, response byte count, retry number, generic error category, request generation, and counts of items after ensuring those fields cannot identify a message.

Keep message data in memory only as long as needed. Bound list size, body size, and any content cache. Clear all in-memory data when credentials change, integration is disabled, or the application shuts down.

## 15. Required Tests

### EmailArchiveClient

- Adds `X-API-Key` and never puts the key in a URL or log.
- Correctly URL-encodes the exact path, ingestion source, and cursor.
- Parses every required summary and content field, including nullable and optional values.
- Ignores unknown JSON fields.
- Rejects missing fields, wrong types, invalid dates, invalid pagination fields, and oversized responses.
- Follows feed cursors without duplicates.
- Initializes, persists, and advances a changes checkpoint.
- Persists the changes cursor on empty responses.
- Immediately drains changes while `hasMore` is true.
- Resets checkpoint state when authentication or filters change.
- Rejects every redirect without forwarding credentials.
- Maps `400`, `401`, `403`, `404`, `429`, and transient `5xx` responses correctly.
- Honors `Retry-After`, timeout, cancellation, backoff, and maximum retry count.
- Suppresses stale list, detail, and poll completions by request generation.

### Model and controller

- Empty, one-item, nullable-field, attachment, long-subject, and long-body fixtures.
- List selection, detail opening, back navigation, and scrolling.
- Automatic next-page loading at the list boundary.
- Plain-text preference and safe HTML-to-text fallback.
- No remote resource requests while processing HTML.
- Inactivity timeout and activity reset.
- Disable, display removal, credentials change, and shutdown cleanup.

### Popup coordinator and renderer

- SMS and email cannot simultaneously own the interactive slot.
- Android notifications remain suppressed for the complete ownership lifetime.
- A non-owner release cannot alter the owner or notification suppression.
- ArcX input routes only to the owner.
- Local overlay pixels never enter recordings or outgoing display streams.
- Textures and message memory are cleared on every close/cleanup path.

### Privacy regression

Capture logs, status JSON, HTML responses, crash breadcrumbs, and test diagnostics while loading representative fixtures. Assert that none contains the API key or any fixture sender, recipient, subject, body, attachment name, message ID, or cursor.

### Optional live smoke test

Gate the live test behind `BR_EMAIL_ARCHIVE_API_KEY`. It should:

1. Request one summary from the configured path.
2. If one exists, request its `/content` representation.
3. Initialize a changes checkpoint and poll it once.
4. Print only status codes, field-presence booleans, counts, and timings.
5. Skip cleanly when the environment key is absent.

Never print live message fields or the cursor.

## 16. Implementation Order

1. Add typed JSON fixtures and `EmailArchiveClient` tests.
2. Implement secure configuration and QKeychain access.
3. Implement list, content, cursor pagination, cancellation, limits, and error mapping.
4. Introduce the popup-slot coordinator and migrate SMS/notification ownership to it.
5. Add the email model, controller, and safe body conversion.
6. Add the local-only email texture renderer.
7. Register the configurable ArcX action and settings entry.
8. Add optional changes polling and durable cursor storage.
9. Run privacy, lifecycle, renderer-boundary, and optional live smoke tests.

## 17. Completion Criteria

The integration is ready when:

- A configured user can open the latest Inbox list and page backward.
- Opening a row displays bounded plain text and attachment metadata.
- No email content or credential can enter logs, public status, recordings, or outgoing streams.
- SMS/email ownership and Android notification suppression remain correct across every close and failure path.
- Configuration changes cannot apply stale network responses.
- Optional background polling survives empty responses and pagination without losing its checkpoint.
- Authentication, permission, rate-limit, timeout, server-error, malformed-response, and offline states fail safely.
- The application performs no email write operation and exposes no send, reply, or attachment-download control.

## 18. API Availability Summary

| Overlay operation           | Endpoint                                                 |
| --------------------------- | -------------------------------------------------------- |
| Fresh recent-message list   | `GET /archived-emails?path=...&limit=...`                |
| Older list page             | Same endpoint with `cursor=nextCursor`                   |
| Selected-message content    | `GET /archived-emails/{id}/content`                      |
| Initialize new-mail polling | `GET /archived-emails/changes?path=...`                  |
| Poll/drain new mail         | Same changes endpoint with `cursor=nextCursor&limit=100` |

All endpoint paths in this table are relative to `https://mail.home.benhoff.net/api/v1`.
