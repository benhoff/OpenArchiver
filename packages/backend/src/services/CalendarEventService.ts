import { and, desc, eq, gt, ilike, isNull, lt, or } from 'drizzle-orm';
import { simpleParser, type ParsedMail } from 'mailparser';
import { createHash } from 'crypto';
import { db } from '../database';
import {
	archivedEmails,
	calendarEventObservations,
	calendarEvents,
} from '../database/schema';
import { logger } from '../config/logger';
import { StorageService } from './StorageService';
import { streamToBuffer } from '../helpers/streamToBuffer';
import { FilterBuilder } from './FilterBuilder';
import type {
	CalendarBackfillResult,
	CalendarConflict,
	CalendarEvent,
	CalendarSourceKind,
} from '@open-archiver/types';

type ArchivedEmailRow = typeof archivedEmails.$inferSelect;
type CalendarEventRow = typeof calendarEvents.$inferSelect;

interface IcsProperty {
	name: string;
	value: string;
	params: Record<string, string>;
}

interface IcsEvent {
	method: string | null;
	properties: IcsProperty[];
}

export interface CalendarEventInput {
	canonicalKey: string;
	ingestionSourceId: string;
	userEmail: string;
	sourceKind: CalendarSourceKind;
	sourceEmailId: string;
	archivedEmailId?: string;
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
}

interface ParseAndUpsertResult {
	parsedEvents: number;
	upsertedEvents: number;
}

const SOURCE_PRIORITIES: Record<CalendarSourceKind, number> = {
	google_calendar: 110,
	outlook_calendar: 100,
	ipm_appointment_eml: 90,
	meeting_update_ics: 70,
	meeting_request_ics: 60,
	cancellation: 55,
	email_ics: 40,
	reply: 20,
};

export class CalendarEventService {
	private storageService = new StorageService();

	public async parseAndUpsertFromEmail(
		email: ArchivedEmailRow,
		rawEmlBuffer: Buffer
	): Promise<ParseAndUpsertResult> {
		const parsed = await simpleParser(rawEmlBuffer);
		const calendarPayloads = this.extractCalendarPayloads(parsed, rawEmlBuffer);

		if (calendarPayloads.length === 0) {
			return { parsedEvents: 0, upsertedEvents: 0 };
		}

		const messageClass =
			this.firstHeaderValue(parsed, 'x-openarchiver-outlook-message-class') ??
			this.tagValue(email.tags, 'outlook-message-class:');
		const outlookEntryId =
			this.firstHeaderValue(parsed, 'x-openarchiver-outlook-entry-id') ?? null;
		const storeId = this.firstHeaderValue(parsed, 'x-openarchiver-outlook-store-id') ?? null;
		const globalAppointmentIdHeader =
			this.firstHeaderValue(parsed, 'x-openarchiver-outlook-global-appointment-id') ?? null;
		const textBody = `${parsed.text ?? ''}\n${typeof parsed.html === 'string' ? parsed.html : ''}`;

		let parsedEvents = 0;
		let upsertedEvents = 0;

		for (const payload of calendarPayloads) {
			for (const icsEvent of this.parseIcsEvents(payload)) {
				const input = this.toCalendarEventInput({
					email,
					icsEvent,
					messageClass,
					outlookEntryId,
					storeId,
					globalAppointmentIdHeader,
					textBody,
				});

				if (!input) {
					continue;
				}

				parsedEvents += 1;
				const upserted = await this.upsertCalendarEvent(input);
				if (upserted) {
					upsertedEvents += 1;
				}
			}
		}

		return { parsedEvents, upsertedEvents };
	}

	public async backfillFromArchivedEmails(
		userId: string,
		options: {
			limit?: number;
			sourceId?: string;
			userEmail?: string;
		} = {}
	): Promise<CalendarBackfillResult> {
		const limit = Math.max(1, Math.min(options.limit ?? 1000, 20000));
		const { drizzleFilter } = await FilterBuilder.create(userId, 'archive', 'read');
		const where = and(
			drizzleFilter,
			options.sourceId ? eq(archivedEmails.ingestionSourceId, options.sourceId) : undefined,
			options.userEmail ? eq(archivedEmails.userEmail, options.userEmail) : undefined,
			or(
				eq(archivedEmails.hasAttachments, true),
				ilike(archivedEmails.subject, '%meeting%'),
				ilike(archivedEmails.subject, '%appointment%'),
				ilike(archivedEmails.subject, '%invite%'),
				ilike(archivedEmails.subject, '%calendar%')
			)
		);

		const emails = await db
			.select()
			.from(archivedEmails)
			.where(where)
			.orderBy(desc(archivedEmails.archivedAt))
			.limit(limit);

		let processed = 0;
		let parsedEvents = 0;
		let upsertedEvents = 0;
		let errors = 0;

		for (const email of emails) {
			try {
				const stream = await this.storageService.get(email.storagePath);
				const rawEmlBuffer = await streamToBuffer(stream);
				const result = await this.parseAndUpsertFromEmail(email, rawEmlBuffer);
				processed += 1;
				parsedEvents += result.parsedEvents;
				upsertedEvents += result.upsertedEvents;
			} catch (error) {
				errors += 1;
				logger.warn(
					{ err: error, archivedEmailId: email.id },
					'Failed to backfill calendar event from archived email.'
				);
			}
		}

		return {
			processed,
			parsedEvents,
			upsertedEvents,
			errors,
			limit,
		};
	}

	public async findConflicts(
		userId: string,
		query: {
			from: Date;
			to: Date;
			includeTentative?: boolean;
			excludeDeclined?: boolean;
			userEmail?: string;
		}
	): Promise<CalendarConflict[]> {
		const { drizzleFilter } = await FilterBuilder.create(userId, 'archive', 'read');
		const includeTentative = query.includeTentative ?? true;
		const excludeDeclined = query.excludeDeclined ?? true;
		const rows = await db
			.select()
			.from(calendarEvents)
			.where(
				and(
					drizzleFilter,
					query.userEmail ? eq(calendarEvents.userEmail, query.userEmail) : undefined,
					isNull(calendarEvents.deletedAt),
					lt(calendarEvents.startAt, query.to),
					gt(calendarEvents.endAt, query.from)
				)
			)
			.orderBy(calendarEvents.userEmail, calendarEvents.startAt);

		const eligible = rows.filter((event) =>
			this.isConflictEligible(event, includeTentative, excludeDeclined)
		);
		const groups = new Map<string, CalendarEventRow[]>();

		for (const event of eligible) {
			const group = groups.get(event.userEmail) ?? [];
			group.push(event);
			groups.set(event.userEmail, group);
		}

		const conflicts: CalendarConflict[] = [];
		for (const [userEmail, events] of groups) {
			events.sort((a, b) => this.requiredDate(a.startAt).getTime() - this.requiredDate(b.startAt).getTime());
			for (let i = 0; i < events.length; i += 1) {
				const a = events[i];
				const aEnd = this.requiredDate(a.endAt);
				for (let j = i + 1; j < events.length; j += 1) {
					const b = events[j];
					const bStart = this.requiredDate(b.startAt);
					if (bStart >= aEnd) {
						break;
					}
					const bEnd = this.requiredDate(b.endAt);
					const overlapStart = new Date(
						Math.max(this.requiredDate(a.startAt).getTime(), bStart.getTime())
					);
					const overlapEnd = new Date(Math.min(aEnd.getTime(), bEnd.getTime()));
					if (overlapStart >= overlapEnd) {
						continue;
					}
					conflicts.push({
						userEmail,
						startAt: overlapStart,
						endAt: overlapEnd,
						hardness:
							this.isTentative(a) || this.isTentative(b) ? 'tentative' : 'hard',
						events: [this.toApiEvent(a), this.toApiEvent(b)],
					});
				}
			}
		}

		return conflicts;
	}

	private extractCalendarPayloads(parsed: ParsedMail, rawEmlBuffer: Buffer): string[] {
		const payloads: string[] = [];

		for (const attachment of parsed.attachments) {
			const contentType = attachment.contentType?.toLowerCase() ?? '';
			const filename = attachment.filename?.toLowerCase() ?? '';
			if (contentType.includes('calendar') || filename.endsWith('.ics')) {
				payloads.push(attachment.content.toString('utf8'));
			}
		}

		const rawText = rawEmlBuffer.toString('utf8');
		const rawMatches = rawText.match(/BEGIN:VCALENDAR[\s\S]*?END:VCALENDAR/g) ?? [];
		payloads.push(...rawMatches);

		return [...new Set(payloads.map((payload) => payload.trim()).filter(Boolean))];
	}

	private parseIcsEvents(payload: string): IcsEvent[] {
		const lines = this.unfoldIcsLines(payload);
		const events: IcsEvent[] = [];
		let method: string | null = null;
		let currentEvent: IcsProperty[] | null = null;

		for (const line of lines) {
			const property = this.parseIcsProperty(line);
			if (!property) {
				continue;
			}
			if (property.name === 'METHOD' && !currentEvent) {
				method = property.value.toUpperCase();
				continue;
			}
			if (property.name === 'BEGIN' && property.value.toUpperCase() === 'VEVENT') {
				currentEvent = [];
				continue;
			}
			if (property.name === 'END' && property.value.toUpperCase() === 'VEVENT') {
				if (currentEvent) {
					events.push({ method, properties: currentEvent });
				}
				currentEvent = null;
				continue;
			}
			if (currentEvent) {
				currentEvent.push(property);
			}
		}

		return events;
	}

	private toCalendarEventInput(args: {
		email: ArchivedEmailRow;
		icsEvent: IcsEvent;
		messageClass: string | null;
		outlookEntryId: string | null;
		storeId: string | null;
		globalAppointmentIdHeader: string | null;
		textBody: string;
	}): CalendarEventInput | null {
		const {
			email,
			icsEvent,
			messageClass,
			outlookEntryId,
			storeId,
			globalAppointmentIdHeader,
			textBody,
		} = args;
		const uid = this.value(icsEvent, 'UID') ?? globalAppointmentIdHeader;
		const method = icsEvent.method;
		const sourceKind = this.inferSourceKind(messageClass, method);
		const start = this.dateValue(icsEvent, 'DTSTART');
		const end = this.dateValue(icsEvent, 'DTEND');
		const startAt = start?.date ?? null;
		const endAt = end?.date ?? null;

		if (!startAt || !endAt) {
			return null;
		}

		const organizer = this.property(icsEvent, 'ORGANIZER');
		const attendees = this.attendees(icsEvent);
		const ownAttendee = attendees.find(
			(attendee) => this.normalizeEmail(attendee.email) === this.normalizeEmail(email.userEmail)
		);
		const status = this.value(icsEvent, 'STATUS')?.toUpperCase() ?? null;
		const sequence = this.value(icsEvent, 'SEQUENCE');
		const lastModified = this.dateValue(icsEvent, 'LAST-MODIFIED')?.date ?? null;
		const location = this.value(icsEvent, 'LOCATION');
		const description = this.value(icsEvent, 'DESCRIPTION');
		const onlineMeetingUrl = this.findOnlineMeetingUrl(
			`${location ?? ''}\n${description ?? ''}\n${textBody}`
		);
		const occurrenceStartAt = startAt;
		const canonicalKey = this.buildCanonicalKey({
			userEmail: email.userEmail,
			globalAppointmentId: uid,
			providerEventId: email.providerMessageId,
			startAt,
			endAt,
			subject: this.value(icsEvent, 'SUMMARY') ?? email.subject,
			organizerEmail: this.mailto(organizer?.value ?? null),
		});

		if (!canonicalKey) {
			return null;
		}

		return {
			canonicalKey,
			ingestionSourceId: email.ingestionSourceId,
			userEmail: email.userEmail,
			sourceKind,
			sourceEmailId: email.id,
			archivedEmailId: email.id,
			sourcePriority: SOURCE_PRIORITIES[sourceKind],
			providerEventId: email.providerMessageId,
			globalAppointmentId: uid,
			outlookEntryId,
			storeId,
			subject: this.value(icsEvent, 'SUMMARY') ?? email.subject,
			organizerName: organizer?.params.CN ?? null,
			organizerEmail: this.mailto(organizer?.value ?? null),
			requiredAttendees: attendees
				.filter((attendee) => attendee.role !== 'OPT-PARTICIPANT')
				.map((attendee) => attendee.email),
			optionalAttendees: attendees
				.filter((attendee) => attendee.role === 'OPT-PARTICIPANT')
				.map((attendee) => attendee.email),
			startAt,
			endAt,
			isAllDay: start?.isAllDay || end?.isAllDay || false,
			busyStatus: this.busyStatus(icsEvent),
			responseStatus:
				this.normalizePartStat(ownAttendee?.partStat ?? null) ??
				this.responseStatusFromMessageClass(messageClass),
			location,
			onlineMeetingUrl,
			isRecurring:
				!!this.property(icsEvent, 'RRULE') ||
				!!this.property(icsEvent, 'RECURRENCE-ID') ||
				!!sequence,
			seriesMasterId: this.value(icsEvent, 'RECURRENCE-ID') ? uid : null,
			occurrenceStartAt,
			lastModifiedAt: lastModified,
			deletedAt:
				status === 'CANCELLED' || method === 'CANCEL' || sourceKind === 'cancellation'
					? email.sentAt
					: null,
		};
	}

	public async upsertCalendarEvent(input: CalendarEventInput): Promise<boolean> {
		const existing = await db.query.calendarEvents.findFirst({
			where: eq(calendarEvents.canonicalKey, input.canonicalKey),
		});

		let calendarEventId: string;
		if (!existing) {
			const [inserted] = await db
				.insert(calendarEvents)
				.values({
					canonicalKey: input.canonicalKey,
					ingestionSourceId: input.ingestionSourceId,
					userEmail: input.userEmail,
					sourceKinds: [input.sourceKind],
					sourceEmailIds: [input.sourceEmailId],
					sourcePriority: input.sourcePriority,
					providerEventId: input.providerEventId,
					globalAppointmentId: input.globalAppointmentId,
					outlookEntryId: input.outlookEntryId,
					storeId: input.storeId,
					subject: input.subject,
					organizerName: input.organizerName,
					organizerEmail: input.organizerEmail,
					requiredAttendees: input.requiredAttendees,
					optionalAttendees: input.optionalAttendees,
					startAt: input.startAt,
					endAt: input.endAt,
					isAllDay: input.isAllDay,
					busyStatus: input.busyStatus,
					responseStatus: input.responseStatus,
					location: input.location,
					onlineMeetingUrl: input.onlineMeetingUrl,
					isRecurring: input.isRecurring,
					seriesMasterId: input.seriesMasterId,
					occurrenceStartAt: input.occurrenceStartAt,
					lastModifiedAt: input.lastModifiedAt,
					deletedAt: input.deletedAt,
				})
				.returning({ id: calendarEvents.id });
			calendarEventId = inserted.id;
		} else {
			calendarEventId = existing.id;
			await db
				.update(calendarEvents)
				.set(this.mergeCalendarEvent(existing, input))
				.where(eq(calendarEvents.id, existing.id));
		}

		if (input.archivedEmailId) {
			await db
				.insert(calendarEventObservations)
				.values({
					calendarEventId,
					archivedEmailId: input.archivedEmailId,
					sourceKind: input.sourceKind,
				})
				.onConflictDoNothing();
		}

		return true;
	}

	private mergeCalendarEvent(
		existing: CalendarEventRow,
		input: CalendarEventInput
	): Partial<typeof calendarEvents.$inferInsert> {
		const incomingWins = input.sourcePriority >= existing.sourcePriority;
		const merged: Partial<typeof calendarEvents.$inferInsert> = {
			sourceKinds: this.unique([...(existing.sourceKinds ?? []), input.sourceKind]),
			sourceEmailIds: this.unique([...(existing.sourceEmailIds ?? []), input.sourceEmailId]),
			sourcePriority: Math.max(existing.sourcePriority, input.sourcePriority),
			requiredAttendees: this.unique([
				...(existing.requiredAttendees ?? []),
				...input.requiredAttendees,
			]),
			optionalAttendees: this.unique([
				...(existing.optionalAttendees ?? []),
				...input.optionalAttendees,
			]),
			isAllDay: existing.isAllDay || input.isAllDay,
			isRecurring: existing.isRecurring || input.isRecurring,
			updatedAt: new Date(),
		};

		this.mergeScalar(merged, existing, input, incomingWins, 'providerEventId');
		this.mergeScalar(merged, existing, input, incomingWins, 'globalAppointmentId');
		this.mergeScalar(merged, existing, input, incomingWins, 'outlookEntryId');
		this.mergeScalar(merged, existing, input, incomingWins, 'storeId');
		this.mergeScalar(merged, existing, input, incomingWins, 'subject');
		this.mergeScalar(merged, existing, input, incomingWins, 'organizerName');
		this.mergeScalar(merged, existing, input, incomingWins, 'organizerEmail');
		this.mergeScalar(merged, existing, input, incomingWins, 'startAt');
		this.mergeScalar(merged, existing, input, incomingWins, 'endAt');
		this.mergeScalar(merged, existing, input, incomingWins, 'busyStatus');
		this.mergeScalar(merged, existing, input, incomingWins, 'responseStatus');
		this.mergeScalar(merged, existing, input, incomingWins, 'location');
		this.mergeScalar(merged, existing, input, incomingWins, 'onlineMeetingUrl');
		this.mergeScalar(merged, existing, input, incomingWins, 'seriesMasterId');
		this.mergeScalar(merged, existing, input, incomingWins, 'occurrenceStartAt');
		this.mergeScalar(merged, existing, input, incomingWins, 'lastModifiedAt');

		if (input.deletedAt) {
			merged.deletedAt = input.deletedAt;
		}

		return merged;
	}

	private mergeScalar<K extends keyof CalendarEventInput & keyof CalendarEventRow>(
		merged: Partial<typeof calendarEvents.$inferInsert>,
		existing: CalendarEventRow,
		input: CalendarEventInput,
		incomingWins: boolean,
		key: K
	): void {
		const incomingValue = input[key];
		if (!this.hasValue(incomingValue)) {
			return;
		}
		if (incomingWins || !this.hasValue(existing[key])) {
			(merged as Record<string, unknown>)[key] = incomingValue;
		}
	}

	private isConflictEligible(
		event: CalendarEventRow,
		includeTentative: boolean,
		excludeDeclined: boolean
	): boolean {
		if (!event.startAt || !event.endAt || event.deletedAt || event.isAllDay) {
			return false;
		}
		const busyStatus = event.busyStatus?.toLowerCase();
		const responseStatus = event.responseStatus?.toLowerCase();
		if (busyStatus === 'free') {
			return false;
		}
		if (excludeDeclined && responseStatus === 'declined') {
			return false;
		}
		if (!includeTentative && this.isTentative(event)) {
			return false;
		}
		return true;
	}

	private isTentative(event: CalendarEventRow): boolean {
		return (
			event.busyStatus?.toLowerCase() === 'tentative' ||
			event.responseStatus?.toLowerCase() === 'tentative'
		);
	}

	private toApiEvent(row: CalendarEventRow): CalendarEvent {
		return {
			...row,
			sourceKinds: row.sourceKinds ?? [],
			sourceEmailIds: row.sourceEmailIds ?? [],
			requiredAttendees: row.requiredAttendees ?? [],
			optionalAttendees: row.optionalAttendees ?? [],
		};
	}

	private inferSourceKind(
		messageClass: string | null,
		method: string | null
	): CalendarSourceKind {
		const normalizedClass = messageClass?.toLowerCase() ?? '';
		const normalizedMethod = method?.toUpperCase() ?? '';

		if (normalizedClass.includes('canceled') || normalizedMethod === 'CANCEL') {
			return 'cancellation';
		}
		if (normalizedClass.includes('resp.') || normalizedMethod === 'REPLY') {
			return 'reply';
		}
		if (normalizedClass.startsWith('ipm.appointment')) {
			return 'ipm_appointment_eml';
		}
		if (normalizedClass.startsWith('ipm.schedule.meeting.request')) {
			return 'meeting_request_ics';
		}
		if (normalizedMethod === 'REQUEST') {
			return 'meeting_request_ics';
		}
		if (normalizedMethod === 'PUBLISH') {
			return 'ipm_appointment_eml';
		}
		return 'email_ics';
	}

	private busyStatus(event: IcsEvent): string | null {
		const microsoftBusy = this.value(event, 'X-MICROSOFT-CDO-BUSYSTATUS');
		if (microsoftBusy) {
			const normalized = microsoftBusy.toLowerCase().replace(/\s+/g, '_');
			return normalized === 'oof' ? 'out_of_office' : normalized;
		}
		const transparency = this.value(event, 'TRANSP')?.toUpperCase();
		if (transparency === 'TRANSPARENT') {
			return 'free';
		}
		if (transparency === 'OPAQUE') {
			return 'busy';
		}
		return null;
	}

	private responseStatusFromMessageClass(messageClass: string | null): string | null {
		const normalized = messageClass?.toLowerCase() ?? '';
		if (normalized.includes('resp.pos')) {
			return 'accepted';
		}
		if (normalized.includes('resp.neg')) {
			return 'declined';
		}
		if (normalized.includes('resp.tent')) {
			return 'tentative';
		}
		return null;
	}

	private normalizePartStat(value: string | null): string | null {
		switch (value?.toUpperCase()) {
			case 'ACCEPTED':
				return 'accepted';
			case 'DECLINED':
				return 'declined';
			case 'TENTATIVE':
				return 'tentative';
			case 'NEEDS-ACTION':
				return 'needs_action';
			default:
				return null;
		}
	}

	private attendees(event: IcsEvent): Array<{
		email: string;
		role: string | null;
		partStat: string | null;
	}> {
		return event.properties
			.filter((property) => property.name === 'ATTENDEE')
			.map((property) => ({
				email: this.mailto(property.value) ?? property.params.CN ?? property.value,
				role: property.params.ROLE ?? null,
				partStat: property.params.PARTSTAT ?? null,
			}))
			.filter((attendee) => attendee.email.trim().length > 0);
	}

	private buildCanonicalKey(args: {
		userEmail: string;
		globalAppointmentId: string | null;
		providerEventId: string | null;
		startAt: Date;
		endAt: Date;
		subject: string | null;
		organizerEmail: string | null;
	}): string | null {
		const userEmail = this.normalizeEmail(args.userEmail);
		const occurrence = args.startAt.toISOString();
		if (args.globalAppointmentId) {
			return `uid:${userEmail}:${this.sha(args.globalAppointmentId)}:${occurrence}`;
		}
		if (args.providerEventId) {
			return `provider:${userEmail}:${this.sha(args.providerEventId)}:${occurrence}:${args.endAt.toISOString()}`;
		}
		const fallback = [
			args.subject ?? '',
			args.organizerEmail ?? '',
			args.startAt.toISOString(),
			args.endAt.toISOString(),
		].join('|');
		return `fallback:${userEmail}:${this.sha(fallback)}`;
	}

	private unfoldIcsLines(payload: string): string[] {
		const lines = payload.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
		const unfolded: string[] = [];
		for (const line of lines) {
			if (/^[ \t]/.test(line) && unfolded.length > 0) {
				unfolded[unfolded.length - 1] += line.slice(1);
			} else {
				unfolded.push(line);
			}
		}
		return unfolded;
	}

	private parseIcsProperty(line: string): IcsProperty | null {
		const separator = line.indexOf(':');
		if (separator < 0) {
			return null;
		}
		const head = line.slice(0, separator);
		const value = this.decodeIcsValue(line.slice(separator + 1));
		const [namePart, ...paramParts] = head.split(';');
		const params: Record<string, string> = {};

		for (const part of paramParts) {
			const equalAt = part.indexOf('=');
			if (equalAt < 0) {
				continue;
			}
			const key = part.slice(0, equalAt).toUpperCase();
			const paramValue = part.slice(equalAt + 1).replace(/^"|"$/g, '');
			params[key] = this.decodeIcsValue(paramValue);
		}

		return {
			name: namePart.toUpperCase(),
			value,
			params,
		};
	}

	private dateValue(event: IcsEvent, name: string): { date: Date; isAllDay: boolean } | null {
		const property = this.property(event, name);
		if (!property) {
			return null;
		}
		return this.parseIcsDate(property.value, property.params.VALUE === 'DATE');
	}

	private parseIcsDate(value: string, forceAllDay: boolean): { date: Date; isAllDay: boolean } | null {
		const dateMatch = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
		if (dateMatch) {
			const [, year, month, day] = dateMatch;
			return {
				date: new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))),
				isAllDay: true,
			};
		}

		const dateTimeMatch = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
		if (!dateTimeMatch) {
			return null;
		}
		const [, year, month, day, hour, minute, second] = dateTimeMatch;
		return {
			date: new Date(
				Date.UTC(
					Number(year),
					Number(month) - 1,
					Number(day),
					Number(hour),
					Number(minute),
					Number(second)
				)
			),
			isAllDay: forceAllDay,
		};
	}

	private property(event: IcsEvent, name: string): IcsProperty | null {
		return event.properties.find((property) => property.name === name) ?? null;
	}

	private value(event: IcsEvent, name: string): string | null {
		return this.property(event, name)?.value ?? null;
	}

	private firstHeaderValue(parsed: ParsedMail, headerName: string): string | null {
		const value = parsed.headers.get(headerName.toLowerCase());
		if (Array.isArray(value)) {
			const first = value[0];
			return typeof first === 'string' ? first : null;
		}
		return typeof value === 'string' ? value : null;
	}

	private tagValue(tags: unknown, prefix: string): string | null {
		if (!Array.isArray(tags)) {
			return null;
		}
		const tag = tags.find((value) => typeof value === 'string' && value.startsWith(prefix));
		return typeof tag === 'string' ? tag.slice(prefix.length) : null;
	}

	private mailto(value: string | null): string | null {
		if (!value) {
			return null;
		}
		return value.replace(/^mailto:/i, '').trim().toLowerCase();
	}

	private normalizeEmail(value: string): string {
		return value.trim().toLowerCase();
	}

	private findOnlineMeetingUrl(text: string): string | null {
		const match = text.match(/https?:\/\/[^\s<>"']+/i);
		return match ? match[0].replace(/[),.;]+$/, '') : null;
	}

	private decodeIcsValue(value: string): string {
		return value
			.replace(/\\n/gi, '\n')
			.replace(/\\,/g, ',')
			.replace(/\\;/g, ';')
			.replace(/\\\\/g, '\\')
			.trim();
	}

	private unique(values: string[]): string[] {
		return [...new Set(values.filter((value) => value.trim().length > 0))];
	}

	private hasValue(value: unknown): boolean {
		return value !== null && value !== undefined && value !== '';
	}

	private requiredDate(value: Date | null): Date {
		if (!value) {
			throw new Error('Expected calendar event date after eligibility filtering.');
		}
		return value;
	}

	private sha(value: string): string {
		return createHash('sha256').update(value).digest('hex');
	}
}
