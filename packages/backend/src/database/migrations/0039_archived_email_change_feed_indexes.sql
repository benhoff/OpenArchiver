CREATE INDEX "archived_email_archived_at_id_idx" ON "archived_emails" USING btree ("archived_at","id");--> statement-breakpoint
CREATE INDEX "archived_email_path_archived_at_id_idx" ON "archived_emails" USING btree ("path","archived_at","id");
