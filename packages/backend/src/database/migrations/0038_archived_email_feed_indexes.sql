CREATE INDEX "archived_email_sent_at_id_idx" ON "archived_emails" USING btree ("sent_at","id");--> statement-breakpoint
CREATE INDEX "archived_email_path_sent_at_id_idx" ON "archived_emails" USING btree ("path","sent_at","id");
