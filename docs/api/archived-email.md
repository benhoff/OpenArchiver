---
aside: false
---

# Archived Email API

Endpoints for retrieving and deleting archived emails. All endpoints require authentication and the appropriate `archive` permission.

## Browse the Message Feed

<OAOperation operationId="getArchivedEmailFeed" />

The feed is newest-first and read-only. Pass the exact archived path to restrict it to a folder:

```http
GET /api/v1/archived-emails?path=ben.hoff%40skan.ai%2FInbox%2F&limit=25
X-API-Key: YOUR_API_KEY
```

When `hasMore` is true, URL-encode the returned `nextCursor` and pass it as `cursor` on the next request. Do not inspect or modify the cursor.

## Poll for Newly Archived Messages

<OAOperation operationId="getArchivedEmailChanges" />

Initialize polling by omitting `cursor`. This deliberately returns no historical messages and gives you a checkpoint in `nextCursor`:

```http
GET /api/v1/archived-emails/changes?path=ben.hoff%40skan.ai%2FInbox%2F
X-API-Key: YOUR_API_KEY
```

Poll again with the same filters and the returned cursor. Results follow the transactional change log in commit order; their timestamps may be out of order:

```http
GET /api/v1/archived-emails/changes?path=ben.hoff%40skan.ai%2FInbox%2F&cursor=OPAQUE_CHECKPOINT&limit=100
X-API-Key: YOUR_API_KEY
```

Always persist the latest `nextCursor`, even when `items` is empty. If `hasMore` is true, request the next page immediately; otherwise, wait before polling again. A cursor is bound to its authenticated user and original `path` and `ingestionSourceId` filters. Inserts still in flight at initialization are delivered after commit. Deleted rows are omitted; updates and permission changes are not change events.

Apply migrations through `0040_archived_email_change_log` before deploying. Earlier timestamp-based polling cursors return `400`; reinitialize polling and refresh the normal feed after upgrading. Archive inserts briefly serialize on a database counter, so archive-writing transactions should be kept short.

## List Emails for an Ingestion Source

<OAOperation operationId="getArchivedEmails" />

## Get a Single Email

<OAOperation operationId="getArchivedEmailById" />

## Get Structured Email Content

<OAOperation operationId="getArchivedEmailContentById" />

## Delete an Email

<OAOperation operationId="deleteArchivedEmail" />
