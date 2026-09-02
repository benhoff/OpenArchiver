import { createHash } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { google, calendar_v3 } from 'googleapis';
import type {
	GoogleCalendarConnection,
	GoogleCalendarListItem,
	GoogleCalendarSyncResult,
} from '@open-archiver/types';
import { db } from '../database';
import {
	calendarEvents,
	googleCalendarConnections,
	ingestionSources,
	type GoogleCalendarSyncState,
} from '../database/schema';
import { CryptoService } from './CryptoService';
import { CalendarEventService, type CalendarEventInput } from './CalendarEventService';
import { logger } from '../config/logger';

type GoogleCalendarConnectionRow = typeof googleCalendarConnections.$inferSelect;

interface GoogleOAuthState {
	userId: string;
	createdAt: string;
}

interface SyncOptions {
	pastDays?: number;
	futureDays?: number;
	calendarIds?: string[];
}

const GOOGLE_CALENDAR_SCOPES = [
	'https://www.googleapis.com/auth/calendar.readonly',
	'https://www.googleapis.com/auth/userinfo.email',
];

export class GoogleCalendarService {
	private calendarEventService = new CalendarEventService();

	public getAuthorizationUrl(userId: string): string {
		const oauthClient = this.getOAuthClient();
		const state = CryptoService.encryptObject<GoogleOAuthState>({
			userId,
			createdAt: new Date().toISOString(),
		});

		return oauthClient.generateAuthUrl({
			access_type: 'offline',
			prompt: 'consent',
			include_granted_scopes: true,
			scope: GOOGLE_CALENDAR_SCOPES,
			state,
		});
	}

	public async handleOAuthCallback(
		code: string,
		encryptedState: string
	): Promise<GoogleCalendarConnection> {
		const state = CryptoService.decryptObject<GoogleOAuthState>(encryptedState);
		if (!state?.userId || !state.createdAt) {
			throw new Error('Invalid Google Calendar OAuth state.');
		}
		const stateAgeMs = Date.now() - new Date(state.createdAt).getTime();
		if (!Number.isFinite(stateAgeMs) || stateAgeMs > 60 * 60 * 1000) {
			throw new Error('Expired Google Calendar OAuth state.');
		}

		const oauthClient = this.getOAuthClient();
		const { tokens } = await oauthClient.getToken(code);
		oauthClient.setCredentials(tokens);

		const oauth2 = google.oauth2({ version: 'v2', auth: oauthClient });
		const profile = await oauth2.userinfo.get();
		const googleAccountEmail = profile.data.email?.toLowerCase();
		if (!googleAccountEmail) {
			throw new Error('Google did not return an account email.');
		}

		const existing = await db.query.googleCalendarConnections.findFirst({
			where: and(
				eq(googleCalendarConnections.userId, state.userId),
				eq(googleCalendarConnections.googleAccountEmail, googleAccountEmail)
			),
		});

		const encryptedRefreshToken = tokens.refresh_token
			? CryptoService.encrypt(tokens.refresh_token)
			: existing?.refreshToken;

		if (!encryptedRefreshToken) {
			throw new Error(
				'Google did not return a refresh token. Remove OpenArchiver access from your Google Account, then connect again.'
			);
		}

		if (existing) {
			const [updated] = await db
				.update(googleCalendarConnections)
				.set({
					refreshToken: encryptedRefreshToken,
					status: 'active',
					lastSyncStatusMessage: 'Google Calendar account reconnected.',
					updatedAt: new Date(),
				})
				.where(eq(googleCalendarConnections.id, existing.id))
				.returning();
			return this.toApiConnection(updated);
		}

		const [source] = await db
			.insert(ingestionSources)
			.values({
				userId: state.userId,
				name: `Google Calendar (${googleAccountEmail})`,
				provider: 'google_calendar',
				credentials: CryptoService.encryptObject({ type: 'google_calendar' }),
				status: 'active',
				lastSyncStatusMessage: 'Google Calendar account connected.',
			})
			.returning();

		const [connection] = await db
			.insert(googleCalendarConnections)
			.values({
				userId: state.userId,
				ingestionSourceId: source.id,
				googleAccountEmail,
				refreshToken: encryptedRefreshToken,
			})
			.returning();

		return this.toApiConnection(connection);
	}

	public async listConnections(userId: string): Promise<GoogleCalendarConnection[]> {
		const rows = await db
			.select()
			.from(googleCalendarConnections)
			.where(eq(googleCalendarConnections.userId, userId));
		return rows.map((row) => this.toApiConnection(row));
	}

	public async listCalendars(
		userId: string,
		connectionId: string
	): Promise<GoogleCalendarListItem[]> {
		const connection = await this.findConnection(userId, connectionId);
		const calendar = this.getCalendarClient(connection);
		const calendars: GoogleCalendarListItem[] = [];
		let pageToken: string | undefined;

		do {
			const response = await calendar.calendarList.list({
				maxResults: 250,
				pageToken,
				showHidden: true,
			});

			for (const item of response.data.items ?? []) {
				if (!item.id) {
					continue;
				}
				calendars.push({
					id: item.id,
					summary: item.summary ?? item.id,
					primary: item.primary ?? false,
					hidden: item.hidden ?? false,
					selected: item.selected ?? false,
					accessRole: item.accessRole ?? 'none',
					timeZone: item.timeZone ?? null,
					backgroundColor: item.backgroundColor ?? null,
				});
			}
			pageToken = response.data.nextPageToken ?? undefined;
		} while (pageToken);

		return calendars;
	}

	public async updateSelectedCalendars(
		userId: string,
		connectionId: string,
		calendarIds: string[]
	): Promise<GoogleCalendarConnection> {
		const connection = await this.findConnection(userId, connectionId);
		const [updated] = await db
			.update(googleCalendarConnections)
			.set({
				selectedCalendarIds: this.unique(calendarIds),
				updatedAt: new Date(),
			})
			.where(eq(googleCalendarConnections.id, connection.id))
			.returning();
		return this.toApiConnection(updated);
	}

	public async syncConnection(
		userId: string,
		connectionId: string,
		options: SyncOptions = {}
	): Promise<GoogleCalendarSyncResult> {
		const connection = await this.findConnection(userId, connectionId);
		const from = new Date();
		from.setDate(from.getDate() - Math.max(0, options.pastDays ?? 30));
		const to = new Date();
		to.setDate(to.getDate() + Math.max(1, options.futureDays ?? 180));

		await db
			.update(googleCalendarConnections)
			.set({
				status: 'syncing',
				lastSyncStartedAt: new Date(),
				lastSyncStatusMessage: 'Google Calendar sync started.',
				updatedAt: new Date(),
			})
			.where(eq(googleCalendarConnections.id, connection.id));

		const calendar = this.getCalendarClient(connection);
		const availableCalendars = await this.listCalendars(userId, connectionId);
		const selectedCalendarIds =
			options.calendarIds && options.calendarIds.length > 0
				? this.unique(options.calendarIds)
				: connection.selectedCalendarIds.length > 0
					? connection.selectedCalendarIds
					: availableCalendars
							.filter((item) => ['owner', 'writer', 'reader'].includes(item.accessRole))
							.map((item) => item.id);

		const calendarById = new Map(availableCalendars.map((item) => [item.id, item]));
		const syncState: GoogleCalendarSyncState = { ...(connection.syncState ?? {}) };
		let calendarsScanned = 0;
		let calendarsSkipped = 0;
		let eventsSeen = 0;
		let eventsUpserted = 0;
		let errors = 0;

		try {
			for (const calendarId of selectedCalendarIds) {
				const calendarListItem = calendarById.get(calendarId);
				if (
					calendarListItem &&
					!['owner', 'writer', 'reader'].includes(calendarListItem.accessRole)
				) {
					calendarsSkipped += 1;
					continue;
				}

				try {
					const result = await this.syncCalendar({
						calendar,
						connection,
						calendarId,
						from,
						to,
					});
					calendarsScanned += 1;
					eventsSeen += result.eventsSeen;
					eventsUpserted += result.eventsUpserted;
					syncState[calendarId] = { lastSyncedAt: new Date().toISOString() };
				} catch (error) {
					errors += 1;
					logger.warn(
						{ err: error, connectionId, calendarId },
						'Failed to sync Google Calendar.'
					);
				}
			}

			const message = `Google Calendar sync complete. calendars=${calendarsScanned} skipped=${calendarsSkipped} events=${eventsSeen} upserted=${eventsUpserted} errors=${errors}`;
			await db
				.update(googleCalendarConnections)
				.set({
					status: errors > 0 ? 'partial_error' : 'active',
					syncState,
					lastSyncFinishedAt: new Date(),
					lastSyncStatusMessage: message,
					updatedAt: new Date(),
				})
				.where(eq(googleCalendarConnections.id, connection.id));

			await db
				.update(ingestionSources)
				.set({
					status: errors > 0 ? 'error' : 'active',
					lastSyncFinishedAt: new Date(),
					lastSyncStatusMessage: message,
					updatedAt: new Date(),
				})
				.where(eq(ingestionSources.id, connection.ingestionSourceId));

			return {
				connectionId,
				calendarsScanned,
				calendarsSkipped,
				eventsSeen,
				eventsUpserted,
				errors,
				from,
				to,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown Google Calendar sync error.';
			await db
				.update(googleCalendarConnections)
				.set({
					status: 'error',
					lastSyncFinishedAt: new Date(),
					lastSyncStatusMessage: message,
					updatedAt: new Date(),
				})
				.where(eq(googleCalendarConnections.id, connection.id));
			await db
				.update(ingestionSources)
				.set({
					status: 'error',
					lastSyncFinishedAt: new Date(),
					lastSyncStatusMessage: message,
					updatedAt: new Date(),
				})
				.where(eq(ingestionSources.id, connection.ingestionSourceId));
			throw error;
		}
	}

	public async syncIngestionSource(
		userId: string,
		ingestionSourceId: string,
		options: SyncOptions = {}
	): Promise<GoogleCalendarSyncResult> {
		const connection = await db.query.googleCalendarConnections.findFirst({
			where: and(
				eq(googleCalendarConnections.userId, userId),
				eq(googleCalendarConnections.ingestionSourceId, ingestionSourceId)
			),
		});
		if (!connection) {
			throw new Error('Google Calendar connection not found for ingestion source.');
		}
		return this.syncConnection(userId, connection.id, options);
	}

	public async syncIngestionSourceById(
		ingestionSourceId: string,
		options: SyncOptions = {}
	): Promise<GoogleCalendarSyncResult> {
		const connection = await db.query.googleCalendarConnections.findFirst({
			where: eq(googleCalendarConnections.ingestionSourceId, ingestionSourceId),
		});
		if (!connection) {
			throw new Error('Google Calendar connection not found for ingestion source.');
		}
		return this.syncConnection(connection.userId, connection.id, options);
	}

	public async deleteConnection(userId: string, connectionId: string): Promise<void> {
		const connection = await this.findConnection(userId, connectionId);
		await db
			.delete(googleCalendarConnections)
			.where(eq(googleCalendarConnections.id, connection.id));
		await db.delete(ingestionSources).where(eq(ingestionSources.id, connection.ingestionSourceId));
	}

	private async syncCalendar(args: {
		calendar: calendar_v3.Calendar;
		connection: GoogleCalendarConnectionRow;
		calendarId: string;
		from: Date;
		to: Date;
	}): Promise<{ eventsSeen: number; eventsUpserted: number }> {
		const { calendar, connection, calendarId, from, to } = args;
		let pageToken: string | undefined;
		let eventsSeen = 0;
		let eventsUpserted = 0;

		do {
			const response = await calendar.events.list({
				calendarId,
				maxResults: 2500,
				orderBy: 'startTime',
				pageToken,
				showDeleted: true,
				singleEvents: true,
				timeMax: to.toISOString(),
				timeMin: from.toISOString(),
			});

			for (const event of response.data.items ?? []) {
				eventsSeen += 1;
				const input = this.toCalendarEventInput(connection, calendarId, event);
				if (!input) {
					if (event.status === 'cancelled') {
						const markedDeleted = await this.markDeletedByProviderEvent(
							connection,
							calendarId,
							event
						);
						eventsUpserted += markedDeleted;
					}
					continue;
				}
				await this.calendarEventService.upsertCalendarEvent(input);
				eventsUpserted += 1;
			}

			pageToken = response.data.nextPageToken ?? undefined;
		} while (pageToken);

		return { eventsSeen, eventsUpserted };
	}

	private toCalendarEventInput(
		connection: GoogleCalendarConnectionRow,
		calendarId: string,
		event: calendar_v3.Schema$Event
	): CalendarEventInput | null {
		const start = this.parseGoogleEventDate(event.start ?? event.originalStartTime);
		const end = this.parseGoogleEventDate(event.end ?? event.originalStartTime);
		if (!start?.date || !end?.date) {
			return null;
		}

		const providerEventId = this.buildProviderEventId(calendarId, event, start.date);
		const canonicalKey = this.buildCanonicalKey({
			userEmail: connection.googleAccountEmail,
			iCalUid: event.iCalUID ?? null,
			providerEventId,
			startAt: start.date,
			endAt: end.date,
		});
		const attendees = event.attendees ?? [];
		const ownAttendee = attendees.find((attendee) => attendee.self);
		const onlineMeetingUrl =
			event.hangoutLink ??
			event.conferenceData?.entryPoints?.find((entryPoint) =>
				['video', 'more'].includes(entryPoint.entryPointType ?? '')
			)?.uri ??
			this.findUrl(event.description ?? '');

		return {
			canonicalKey,
			ingestionSourceId: connection.ingestionSourceId,
			userEmail: connection.googleAccountEmail,
			sourceKind: 'google_calendar',
			sourceEmailId: `google-calendar:${connection.id}:${providerEventId}`,
			sourcePriority: 110,
			providerEventId,
			globalAppointmentId: event.iCalUID ?? event.id ?? null,
			outlookEntryId: null,
			storeId: calendarId,
			subject: event.summary ?? (event.status === 'cancelled' ? 'Cancelled event' : null),
			organizerName: event.organizer?.displayName ?? null,
			organizerEmail: event.organizer?.email ?? null,
			requiredAttendees: attendees
				.filter((attendee) => !attendee.optional && attendee.email)
				.map((attendee) => attendee.email as string),
			optionalAttendees: attendees
				.filter((attendee) => attendee.optional && attendee.email)
				.map((attendee) => attendee.email as string),
			startAt: start.date,
			endAt: end.date,
			isAllDay: start.isAllDay || end.isAllDay,
			busyStatus: this.busyStatus(event),
			responseStatus: this.responseStatus(ownAttendee?.responseStatus ?? null),
			location: event.location ?? null,
			onlineMeetingUrl,
			isRecurring: !!event.recurringEventId || !!event.recurrence?.length,
			seriesMasterId: event.recurringEventId ?? null,
			occurrenceStartAt: start.date,
			lastModifiedAt: event.updated ? new Date(event.updated) : null,
			deletedAt:
				event.status === 'cancelled'
					? event.updated
						? new Date(event.updated)
						: new Date()
					: null,
		};
	}

	private async markDeletedByProviderEvent(
		connection: GoogleCalendarConnectionRow,
		calendarId: string,
		event: calendar_v3.Schema$Event
	): Promise<number> {
		const providerEventId = this.buildProviderEventId(calendarId, event);
		const deletedAt = event.updated ? new Date(event.updated) : new Date();
		const updated = await db
			.update(calendarEvents)
			.set({
				deletedAt,
				lastModifiedAt: deletedAt,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(calendarEvents.ingestionSourceId, connection.ingestionSourceId),
					eq(calendarEvents.providerEventId, providerEventId)
				)
			)
			.returning({ id: calendarEvents.id });
		return updated.length;
	}

	private getCalendarClient(connection: GoogleCalendarConnectionRow): calendar_v3.Calendar {
		const oauthClient = this.getOAuthClient();
		const refreshToken = CryptoService.decrypt(connection.refreshToken);
		if (!refreshToken) {
			throw new Error('Failed to decrypt Google Calendar refresh token.');
		}
		oauthClient.setCredentials({ refresh_token: refreshToken });
		return google.calendar({ version: 'v3', auth: oauthClient });
	}

	private getOAuthClient() {
		const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
		const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
		const redirectUri =
			process.env.GOOGLE_CALENDAR_REDIRECT_URI ??
			`${process.env.APP_URL ?? 'http://localhost:3000'}/api/v1/google-calendar/callback`;

		if (!clientId || !clientSecret) {
			throw new Error(
				'GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET must be set.'
			);
		}

		return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
	}

	private async findConnection(
		userId: string,
		connectionId: string
	): Promise<GoogleCalendarConnectionRow> {
		const connection = await db.query.googleCalendarConnections.findFirst({
			where: and(
				eq(googleCalendarConnections.id, connectionId),
				eq(googleCalendarConnections.userId, userId)
			),
		});
		if (!connection) {
			throw new Error('Google Calendar connection not found.');
		}
		return connection;
	}

	private parseGoogleEventDate(
		value?: calendar_v3.Schema$EventDateTime
	): { date: Date; isAllDay: boolean } | null {
		if (!value) {
			return null;
		}
		if (value.dateTime) {
			return { date: new Date(value.dateTime), isAllDay: false };
		}
		if (value.date) {
			const [year, month, day] = value.date.split('-').map(Number);
			return {
				date: new Date(Date.UTC(year, month - 1, day)),
				isAllDay: true,
			};
		}
		return null;
	}

	private busyStatus(event: calendar_v3.Schema$Event): string | null {
		if (event.transparency === 'transparent') {
			return 'free';
		}
		if (event.eventType === 'outOfOffice') {
			return 'out_of_office';
		}
		return 'busy';
	}

	private responseStatus(value: string | null): string | null {
		switch (value) {
			case 'accepted':
			case 'declined':
			case 'tentative':
				return value;
			case 'needsAction':
				return 'needs_action';
			default:
				return null;
		}
	}

	private buildCanonicalKey(args: {
		userEmail: string;
		iCalUid: string | null;
		providerEventId: string;
		startAt: Date;
		endAt: Date;
	}): string {
		const userEmail = args.userEmail.trim().toLowerCase();
		if (args.iCalUid) {
			return `uid:${userEmail}:${this.sha(args.iCalUid)}:${args.startAt.toISOString()}`;
		}
		return `provider:${userEmail}:${this.sha(args.providerEventId)}:${args.startAt.toISOString()}:${args.endAt.toISOString()}`;
	}

	private buildProviderEventId(
		calendarId: string,
		event: calendar_v3.Schema$Event,
		startAt?: Date
	): string {
		return `${calendarId}:${event.id ?? event.iCalUID ?? startAt?.toISOString() ?? 'unknown'}`;
	}

	private findUrl(text: string): string | null {
		const match = text.match(/https?:\/\/[^\s<>"']+/i);
		return match ? match[0].replace(/[),.;]+$/, '') : null;
	}

	private toApiConnection(row: GoogleCalendarConnectionRow): GoogleCalendarConnection {
		return {
			id: row.id,
			ingestionSourceId: row.ingestionSourceId,
			userId: row.userId,
			googleAccountEmail: row.googleAccountEmail,
			selectedCalendarIds: row.selectedCalendarIds ?? [],
			status: row.status,
			lastSyncStartedAt: row.lastSyncStartedAt,
			lastSyncFinishedAt: row.lastSyncFinishedAt,
			lastSyncStatusMessage: row.lastSyncStatusMessage,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		};
	}

	private unique(values: string[]): string[] {
		return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
	}

	private sha(value: string): string {
		return createHash('sha256').update(value).digest('hex');
	}
}
