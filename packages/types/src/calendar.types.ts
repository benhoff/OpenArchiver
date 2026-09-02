export type CalendarSourceKind =
	| 'outlook_calendar'
	| 'ipm_appointment_eml'
	| 'meeting_request_ics'
	| 'meeting_update_ics'
	| 'cancellation'
	| 'reply'
	| 'email_ics'
	| 'google_calendar';

export interface CalendarEvent {
	id: string;
	canonicalKey: string;
	ingestionSourceId: string;
	userEmail: string;
	sourceKinds: string[];
	sourceEmailIds: string[];
	sourcePriority: number;
	providerEventId: string | null;
	globalAppointmentId: string | null;
	outlookEntryId: string | null;
	storeId: string | null;
	subject: string | null;
	organizerName: string | null;
	organizerEmail: string | null;
	requiredAttendees: string[];
	optionalAttendees: string[];
	startAt: Date | null;
	endAt: Date | null;
	isAllDay: boolean;
	busyStatus: string | null;
	responseStatus: string | null;
	location: string | null;
	onlineMeetingUrl: string | null;
	isRecurring: boolean;
	seriesMasterId: string | null;
	occurrenceStartAt: Date | null;
	lastModifiedAt: Date | null;
	deletedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface CalendarConflict {
	userEmail: string;
	startAt: Date;
	endAt: Date;
	hardness: 'hard' | 'tentative';
	events: [CalendarEvent, CalendarEvent];
}

export interface CalendarConflictQuery {
	from: Date;
	to: Date;
	includeTentative?: boolean;
	excludeDeclined?: boolean;
	userEmail?: string;
}

export interface CalendarBackfillResult {
	processed: number;
	parsedEvents: number;
	upsertedEvents: number;
	errors: number;
	limit: number;
}

export interface GoogleCalendarConnection {
	id: string;
	ingestionSourceId: string;
	userId: string;
	googleAccountEmail: string;
	selectedCalendarIds: string[];
	status: string;
	lastSyncStartedAt: Date | null;
	lastSyncFinishedAt: Date | null;
	lastSyncStatusMessage: string | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface GoogleCalendarListItem {
	id: string;
	summary: string;
	primary: boolean;
	hidden: boolean;
	selected: boolean;
	accessRole: string;
	timeZone: string | null;
	backgroundColor: string | null;
}

export interface GoogleCalendarSyncResult {
	connectionId: string;
	calendarsScanned: number;
	calendarsSkipped: number;
	eventsSeen: number;
	eventsUpserted: number;
	errors: number;
	from: Date;
	to: Date;
}
