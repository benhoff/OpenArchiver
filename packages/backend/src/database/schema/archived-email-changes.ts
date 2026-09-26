import { sql } from 'drizzle-orm';
import { bigint, check, integer, pgTable, uuid } from 'drizzle-orm/pg-core';
import { archivedEmails } from './archived-emails';

// Updated by the INSERT trigger, in the same transaction as the archive row.
// A normal sequence would permit later positions to commit before earlier ones.
export const archivedEmailChangeCounter = pgTable(
	'archived_email_change_counter',
	{
		id: integer('id').primaryKey(),
		position: bigint('position', { mode: 'bigint' }).notNull(),
	},
	(table) => [check('archived_email_change_counter_singleton', sql`${table.id} = 1`)]
);

export const archivedEmailChanges = pgTable('archived_email_changes', {
	position: bigint('position', { mode: 'bigint' }).primaryKey(),
	emailId: uuid('email_id')
		.notNull()
		.unique()
		.references(() => archivedEmails.id, { onDelete: 'cascade' }),
});
