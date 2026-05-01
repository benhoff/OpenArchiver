import { Router } from 'express';
import { CalendarEventController } from '../controllers/calendar-event.controller';
import { requireAuth } from '../middleware/requireAuth';
import { requirePermission } from '../middleware/requirePermission';
import { AuthService } from '../../services/AuthService';

export const createCalendarEventRouter = (
	calendarEventController: CalendarEventController,
	authService: AuthService
): Router => {
	const router = Router();

	router.use(requireAuth(authService));

	router.get(
		'/conflicts',
		requirePermission('read', 'archive'),
		calendarEventController.findConflicts
	);

	router.post(
		'/backfill',
		requirePermission('sync', 'ingestion'),
		calendarEventController.backfill
	);

	return router;
};
