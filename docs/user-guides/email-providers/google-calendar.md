# Connecting Google Calendar

Google Calendar uses OAuth because personal Google accounts do not support service-account impersonation. The integration reads calendar metadata only and stores events in `calendar_events` for conflict detection.

## Google Cloud Setup

1. Create or open a Google Cloud project.
2. Enable the Google Calendar API.
3. Configure the OAuth consent screen. For a personal/local setup, External + Testing is enough if you add your Google account as a test user.
4. Create an OAuth client ID with application type `Web application`.
5. Add this authorized redirect URI:

```text
http://localhost:3000/api/v1/google-calendar/callback
```

If `APP_URL` is not `http://localhost:3000`, use `${APP_URL}/api/v1/google-calendar/callback` instead.

## Environment

Add these values to `.env`:

```env
GOOGLE_CALENDAR_CLIENT_ID=your-oauth-client-id
GOOGLE_CALENDAR_CLIENT_SECRET=your-oauth-client-secret
GOOGLE_CALENDAR_REDIRECT_URI=http://localhost:3000/api/v1/google-calendar/callback
```

Restart OpenArchiver after changing the environment.

## Connect and Sync

Request an authorization URL:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/v1/google-calendar/auth-url
```

Open the returned URL in your browser and approve access. The callback creates a `google_calendar` ingestion source.

By default, sync scans the last 30 days and next 180 days. It expands recurring events inside that window and writes one row per occurrence.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"pastDays":30,"futureDays":180}' \
  http://localhost:3000/api/v1/google-calendar/connections/{connectionId}/sync
```

You can also use the force sync action on the Google Calendar ingestion source.

## Shared Calendars

Shared calendars are included when Google exposes them through the Calendar List API with `owner`, `writer`, or `reader` access. Calendars with free/busy-only access are skipped because they do not provide enough event detail for organizer, attendee, location, and meeting URL parsing.

To restrict sync to specific calendars:

```bash
curl -X PUT -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"calendarIds":["primary","shared-calendar-id@group.calendar.google.com"]}' \
  http://localhost:3000/api/v1/google-calendar/connections/{connectionId}/calendars
```
