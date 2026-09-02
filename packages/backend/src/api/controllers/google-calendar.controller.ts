import { Request, Response } from 'express';
import { GoogleCalendarService } from '../../services/GoogleCalendarService';
import { logger } from '../../config/logger';

export class GoogleCalendarController {
	private googleCalendarService = new GoogleCalendarService();

	public getAuthorizationUrl = async (req: Request, res: Response): Promise<Response> => {
		try {
			const userId = req.user?.sub;
			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}

			const url = this.googleCalendarService.getAuthorizationUrl(userId);
			return res.status(200).json({ url });
		} catch (error) {
			const message = error instanceof Error ? error.message : req.t('errors.unknown');
			return res.status(400).json({ message });
		}
	};

	public handleOAuthCallback = async (req: Request, res: Response): Promise<void | Response> => {
		try {
			const code = typeof req.query.code === 'string' ? req.query.code : null;
			const state = typeof req.query.state === 'string' ? req.query.state : null;
			if (!code || !state) {
				return this.html(res, 400, 'Google Calendar connection failed', 'Missing OAuth code or state.');
			}

			await this.googleCalendarService.handleOAuthCallback(code, state);
			res.redirect(this.dashboardRedirectUrl('connected'));
			return;
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown Google Calendar OAuth error.';
			logger.error({ err: error }, 'Google Calendar OAuth callback failed');
			return this.html(res, 400, 'Google Calendar connection failed', message);
		}
	};

	public listConnections = async (req: Request, res: Response): Promise<Response> => {
		try {
			const userId = req.user?.sub;
			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}

			const connections = await this.googleCalendarService.listConnections(userId);
			return res.status(200).json({ connections });
		} catch (error) {
			const message = error instanceof Error ? error.message : req.t('errors.unknown');
			return res.status(500).json({ message });
		}
	};

	public listCalendars = async (req: Request, res: Response): Promise<Response> => {
		try {
			const userId = req.user?.sub;
			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}

			const calendars = await this.googleCalendarService.listCalendars(userId, req.params.id);
			return res.status(200).json({ calendars });
		} catch (error) {
			const message = error instanceof Error ? error.message : req.t('errors.unknown');
			const status = message.includes('not found') ? 404 : 500;
			return res.status(status).json({ message });
		}
	};

	public updateSelectedCalendars = async (req: Request, res: Response): Promise<Response> => {
		try {
			const userId = req.user?.sub;
			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}

			const calendarIds = Array.isArray(req.body?.calendarIds)
				? req.body.calendarIds.filter((id: unknown): id is string => typeof id === 'string')
				: [];
			const connection = await this.googleCalendarService.updateSelectedCalendars(
				userId,
				req.params.id,
				calendarIds
			);
			return res.status(200).json({ connection });
		} catch (error) {
			const message = error instanceof Error ? error.message : req.t('errors.unknown');
			const status = message.includes('not found') ? 404 : 500;
			return res.status(status).json({ message });
		}
	};

	public syncConnection = async (req: Request, res: Response): Promise<Response> => {
		try {
			const userId = req.user?.sub;
			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}

			const result = await this.googleCalendarService.syncConnection(userId, req.params.id, {
				pastDays: this.parsePositiveInteger(req.body?.pastDays),
				futureDays: this.parsePositiveInteger(req.body?.futureDays),
				calendarIds: Array.isArray(req.body?.calendarIds)
					? req.body.calendarIds.filter((id: unknown): id is string => typeof id === 'string')
					: undefined,
			});
			return res.status(202).json(result);
		} catch (error) {
			const message = error instanceof Error ? error.message : req.t('errors.unknown');
			const status = message.includes('not found') ? 404 : 500;
			return res.status(status).json({ message });
		}
	};

	public deleteConnection = async (req: Request, res: Response): Promise<Response> => {
		try {
			const userId = req.user?.sub;
			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}

			await this.googleCalendarService.deleteConnection(userId, req.params.id);
			return res.status(204).send();
		} catch (error) {
			const message = error instanceof Error ? error.message : req.t('errors.unknown');
			const status = message.includes('not found') ? 404 : 500;
			return res.status(status).json({ message });
		}
	};

	private parsePositiveInteger(value: unknown): number | undefined {
		if (typeof value !== 'number' && typeof value !== 'string') {
			return undefined;
		}
		const parsed = Number(value);
		return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
	}

	private dashboardRedirectUrl(status: string): string {
		const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
		const url = new URL('/dashboard/ingestions', appUrl);
		url.searchParams.set('googleCalendar', status);
		return url.toString();
	}

	private html(res: Response, status: number, title: string, message: string): Response {
		const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${this.escapeHtml(title)}</title>
</head>
<body>
  <h1>${this.escapeHtml(title)}</h1>
  <p>${this.escapeHtml(message)}</p>
  <p><a href="${this.escapeHtml(this.dashboardRedirectUrl('error'))}">Return to OpenArchiver</a></p>
</body>
</html>`;
		return res.status(status).type('html').send(body);
	}

	private escapeHtml(value: string): string {
		return value
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#039;');
	}
}
