CREATE TABLE "archived_email_change_counter" (
	"id" integer PRIMARY KEY NOT NULL,
	"position" bigint NOT NULL,
	CONSTRAINT "archived_email_change_counter_singleton" CHECK ("id" = 1)
);
--> statement-breakpoint
INSERT INTO "archived_email_change_counter" ("id", "position") VALUES (1, 0);
--> statement-breakpoint
CREATE TABLE "archived_email_changes" (
	"position" bigint PRIMARY KEY NOT NULL,
	"email_id" uuid NOT NULL UNIQUE REFERENCES "archived_emails" ("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE FUNCTION record_archived_email_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	next_position bigint;
BEGIN
	-- The row lock is held through commit/rollback. No later position can become
	-- visible before this transaction finishes, unlike nextval() or timestamps.
	UPDATE archived_email_change_counter SET position = position + 1
	WHERE id = 1 RETURNING position INTO STRICT next_position;
	INSERT INTO archived_email_changes (position, email_id) VALUES (next_position, NEW.id);
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER archived_email_change_insert
AFTER INSERT ON "archived_emails"
FOR EACH ROW EXECUTE FUNCTION record_archived_email_change();
