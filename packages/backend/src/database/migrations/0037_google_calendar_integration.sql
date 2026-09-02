ALTER TYPE "public"."ingestion_provider" ADD VALUE IF NOT EXISTS 'google_calendar';
--> statement-breakpoint
CREATE TABLE "google_calendar_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"ingestion_source_id" uuid NOT NULL,
	"google_account_email" text NOT NULL,
	"refresh_token" text NOT NULL,
	"selected_calendar_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sync_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_sync_started_at" timestamp with time zone,
	"last_sync_finished_at" timestamp with time zone,
	"last_sync_status_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "google_calendar_connections" ADD CONSTRAINT "google_calendar_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "google_calendar_connections" ADD CONSTRAINT "google_calendar_connections_ingestion_source_id_ingestion_sources_id_fk" FOREIGN KEY ("ingestion_source_id") REFERENCES "public"."ingestion_sources"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "google_calendar_connections_user_email_uidx" ON "google_calendar_connections" USING btree ("user_id","google_account_email");
--> statement-breakpoint
CREATE UNIQUE INDEX "google_calendar_connections_source_uidx" ON "google_calendar_connections" USING btree ("ingestion_source_id");
--> statement-breakpoint
CREATE INDEX "google_calendar_connections_user_idx" ON "google_calendar_connections" USING btree ("user_id");
