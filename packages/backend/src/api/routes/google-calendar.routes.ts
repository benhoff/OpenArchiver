import { Router } from 'express';
import { GoogleCalendarController } from '../controllers/google-calendar.controller';
import { requireAuth } from '../middleware/requireAuth';
import { requirePermission } from '../middleware/requirePermission';
import { AuthService } from '../../services/AuthService';

export const createGoogleCalendarRouter = (
	googleCalendarController: GoogleCalendarController,
	authService: AuthService
): Router => {
	const router = Router();

	router.get('/callback', googleCalendarController.handleOAuthCallback);

	router.use(requireAuth(authService));
	router.use(requirePermission('sync', 'ingestion'));

	router.get('/auth-url', googleCalendarController.getAuthorizationUrl);
	router.get('/connections', googleCalendarController.listConnections);
	router.get('/connections/:id/calendars', googleCalendarController.listCalendars);
	router.put('/connections/:id/calendars', googleCalendarController.updateSelectedCalendars);
	router.post('/connections/:id/sync', googleCalendarController.syncConnection);
	router.delete('/connections/:id', googleCalendarController.deleteConnection);

	return router;
};
