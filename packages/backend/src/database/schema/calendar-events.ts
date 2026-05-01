import { relations } from 'drizzle-orm';
import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from 'drizzle-orm/pg-core';
import { archivedEmails } from './archived-emails';
import { ingestionSources } from './ingestion-sources';

export const calendarEvents = pgTable(
	'calendar_events',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		canonicalKey: text('canonical_key').notNull(),
		ingestionSourceId: uuid('ingestion_source_id')
			.notNull()
			.references(() => ingestionSources.id, { onDelete: 'cascade' }),
		userEmail: text('user_email').notNull(),
		sourceKinds: jsonb('source_kinds').notNull().$type<string[]>().default([]),
		sourceEmailIds: jsonb('source_email_ids').notNull().$type<string[]>().default([]),
		sourcePriority: integer('source_priority').notNull().default(0),
		providerEventId: text('provider_event_id'),
		globalAppointmentId: text('global_appointment_id'),
		outlookEntryId: text('outlook_entry_id'),
		storeId: text('store_id'),
		subject: text('subject'),
		organizerName: text('organizer_name'),
		organizerEmail: text('organizer_email'),
		requiredAttendees: jsonb('required_attendees').notNull().$type<string[]>().default([]),
		optionalAttendees: jsonb('optional_attendees').notNull().$type<string[]>().default([]),
		startAt: timestamp('start_at', { withTimezone: true }),
		endAt: timestamp('end_at', { withTimezone: true }),
		isAllDay: boolean('is_all_day').notNull().default(false),
		busyStatus: text('busy_status'),
		responseStatus: text('response_status'),
		location: text('location'),
		onlineMeetingUrl: text('online_meeting_url'),
		isRecurring: boolean('is_recurring').notNull().default(false),
		seriesMasterId: text('series_master_id'),
		occurrenceStartAt: timestamp('occurrence_start_at', { withTimezone: true }),
		lastModifiedAt: timestamp('last_modified_at', { withTimezone: true }),
		deletedAt: timestamp('deleted_at', { withTimezone: true }),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex('calendar_events_canonical_key_uidx').on(table.canonicalKey),
		index('calendar_events_user_time_idx').on(table.userEmail, table.startAt, table.endAt),
		index('calendar_events_source_idx').on(table.ingestionSourceId),
		index('calendar_events_global_occurrence_idx').on(
			table.globalAppointmentId,
			table.occurrenceStartAt
		),
	]
);

export const calendarEventsRelations = relations(calendarEvents, ({ one }) => ({
	ingestionSource: one(ingestionSources, {
		fields: [calendarEvents.ingestionSourceId],
		references: [ingestionSources.id],
	}),
}));

export const calendarEventObservations = pgTable(
	'calendar_event_observations',
	{
		calendarEventId: uuid('calendar_event_id')
			.notNull()
			.references(() => calendarEvents.id, { onDelete: 'cascade' }),
		archivedEmailId: uuid('archived_email_id')
			.notNull()
			.references(() => archivedEmails.id, { onDelete: 'cascade' }),
		sourceKind: text('source_kind').notNull(),
		observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex('calendar_event_observations_uidx').on(
			table.calendarEventId,
			table.archivedEmailId,
			table.sourceKind
		),
		index('calendar_event_observations_email_idx').on(table.archivedEmailId),
	]
);

export const calendarEventObservationsRelations = relations(
	calendarEventObservations,
	({ one }) => ({
		calendarEvent: one(calendarEvents, {
			fields: [calendarEventObservations.calendarEventId],
			references: [calendarEvents.id],
		}),
		archivedEmail: one(archivedEmails, {
			fields: [calendarEventObservations.archivedEmailId],
			references: [archivedEmails.id],
		}),
	})
);
