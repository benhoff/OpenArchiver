import { Request, Response } from 'express';
import { CalendarEventService } from '../../services/CalendarEventService';

export class CalendarEventController {
	private calendarEventService = new CalendarEventService();

	public findConflicts = async (req: Request, res: Response): Promise<Response> => {
		try {
			const userId = req.user?.sub;
			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}

			const from = this.parseDate(req.query.from as string | undefined);
			const to = this.parseDate(req.query.to as string | undefined);
			if (!from || !to || from >= to) {
				return res.status(400).json({
					message: 'Valid from and to query parameters are required.',
				});
			}

			const conflicts = await this.calendarEventService.findConflicts(userId, {
				from,
				to,
				includeTentative: this.parseBoolean(req.query.includeTentative, true),
				excludeDeclined: this.parseBoolean(req.query.excludeDeclined, true),
				userEmail:
					typeof req.query.userEmail === 'string' ? req.query.userEmail : undefined,
			});

			return res.status(200).json({ conflicts });
		} catch (error) {
			const message = error instanceof Error ? error.message : req.t('errors.unknown');
			return res.status(500).json({ message });
		}
	};

	public backfill = async (req: Request, res: Response): Promise<Response> => {
		try {
			const userId = req.user?.sub;
			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}

			const result = await this.calendarEventService.backfillFromArchivedEmails(userId, {
				limit: this.parsePositiveInteger(req.body?.limit),
				sourceId: typeof req.body?.sourceId === 'string' ? req.body.sourceId : undefined,
				userEmail: typeof req.body?.userEmail === 'string' ? req.body.userEmail : undefined,
			});

			return res.status(202).json(result);
		} catch (error) {
			const message = error instanceof Error ? error.message : req.t('errors.unknown');
			return res.status(500).json({ message });
		}
	};

	private parseDate(value: string | undefined): Date | null {
		if (!value) {
			return null;
		}
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? null : date;
	}

	private parseBoolean(value: unknown, defaultValue: boolean): boolean {
		if (typeof value !== 'string') {
			return defaultValue;
		}
		return ['1', 'true', 'yes'].includes(value.toLowerCase());
	}

	private parsePositiveInteger(value: unknown): number | undefined {
		if (typeof value !== 'number' && typeof value !== 'string') {
			return undefined;
		}
		const parsed = Number(value);
		return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
	}
}
