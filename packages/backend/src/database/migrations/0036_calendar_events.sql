CREATE TABLE "calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_key" text NOT NULL,
	"ingestion_source_id" uuid NOT NULL,
	"user_email" text NOT NULL,
	"source_kinds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_email_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_priority" integer DEFAULT 0 NOT NULL,
	"provider_event_id" text,
	"global_appointment_id" text,
	"outlook_entry_id" text,
	"store_id" text,
	"subject" text,
	"organizer_name" text,
	"organizer_email" text,
	"required_attendees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"optional_attendees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"is_all_day" boolean DEFAULT false NOT NULL,
	"busy_status" text,
	"response_status" text,
	"location" text,
	"online_meeting_url" text,
	"is_recurring" boolean DEFAULT false NOT NULL,
	"series_master_id" text,
	"occurrence_start_at" timestamp with time zone,
	"last_modified_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_event_observations" (
	"calendar_event_id" uuid NOT NULL,
	"archived_email_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_ingestion_source_id_ingestion_sources_id_fk" FOREIGN KEY ("ingestion_source_id") REFERENCES "public"."ingestion_sources"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "calendar_event_observations" ADD CONSTRAINT "calendar_event_observations_calendar_event_id_calendar_events_id_fk" FOREIGN KEY ("calendar_event_id") REFERENCES "public"."calendar_events"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "calendar_event_observations" ADD CONSTRAINT "calendar_event_observations_archived_email_id_archived_emails_id_fk" FOREIGN KEY ("archived_email_id") REFERENCES "public"."archived_emails"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_events_canonical_key_uidx" ON "calendar_events" USING btree ("canonical_key");
--> statement-breakpoint
CREATE INDEX "calendar_events_user_time_idx" ON "calendar_events" USING btree ("user_email","start_at","end_at");
--> statement-breakpoint
CREATE INDEX "calendar_events_source_idx" ON "calendar_events" USING btree ("ingestion_source_id");
--> statement-breakpoint
CREATE INDEX "calendar_events_global_occurrence_idx" ON "calendar_events" USING btree ("global_appointment_id","occurrence_start_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_event_observations_uidx" ON "calendar_event_observations" USING btree ("calendar_event_id","archived_email_id","source_kind");
--> statement-breakpoint
CREATE INDEX "calendar_event_observations_email_idx" ON "calendar_event_observations" USING btree ("archived_email_id");
