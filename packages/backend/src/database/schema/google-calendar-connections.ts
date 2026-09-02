import { relations } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { ingestionSources } from './ingestion-sources';
import { users } from './users';

export type GoogleCalendarSyncState = Record<
	string,
	{
		nextSyncToken?: string;
		lastSyncedAt?: string;
	}
>;

export const googleCalendarConnections = pgTable(
	'google_calendar_connections',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		ingestionSourceId: uuid('ingestion_source_id')
			.notNull()
			.references(() => ingestionSources.id, { onDelete: 'cascade' }),
		googleAccountEmail: text('google_account_email').notNull(),
		refreshToken: text('refresh_token').notNull(),
		selectedCalendarIds: jsonb('selected_calendar_ids').notNull().$type<string[]>().default([]),
		syncState: jsonb('sync_state').notNull().$type<GoogleCalendarSyncState>().default({}),
		status: text('status').notNull().default('active'),
		lastSyncStartedAt: timestamp('last_sync_started_at', { withTimezone: true }),
		lastSyncFinishedAt: timestamp('last_sync_finished_at', { withTimezone: true }),
		lastSyncStatusMessage: text('last_sync_status_message'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex('google_calendar_connections_user_email_uidx').on(
			table.userId,
			table.googleAccountEmail
		),
		uniqueIndex('google_calendar_connections_source_uidx').on(table.ingestionSourceId),
		index('google_calendar_connections_user_idx').on(table.userId),
	]
);

export const googleCalendarConnectionsRelations = relations(
	googleCalendarConnections,
	({ one }) => ({
		user: one(users, {
			fields: [googleCalendarConnections.userId],
			references: [users.id],
		}),
		ingestionSource: one(ingestionSources, {
			fields: [googleCalendarConnections.ingestionSourceId],
			references: [ingestionSources.id],
		}),
	})
);
