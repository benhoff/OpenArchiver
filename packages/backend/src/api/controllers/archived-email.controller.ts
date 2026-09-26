import { Request, Response } from 'express';
import {
	ArchivedEmailService,
	InvalidArchivedEmailChangesCursorError,
	InvalidArchivedEmailFeedCursorError,
} from '../../services/ArchivedEmailService';
import { UserService } from '../../services/UserService';
import { checkDeletionEnabled } from '../../helpers/deletionGuard';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ArchivedEmailController {
	private userService = new UserService();

	public getArchivedEmailFeed = async (req: Request, res: Response): Promise<Response> => {
		const userId = req.user?.sub;
		if (!userId) {
			return res.status(401).json({ message: req.t('errors.unauthorized') });
		}

		const rawLimit = req.query.limit;
		if (rawLimit !== undefined && (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit))) {
			return res.status(400).json({ message: 'limit must be an integer between 1 and 100.' });
		}

		const limit = rawLimit === undefined ? 25 : Number(rawLimit);
		if (limit < 1 || limit > 100) {
			return res.status(400).json({ message: 'limit must be an integer between 1 and 100.' });
		}

		const path = req.query.path;
		if (
			path !== undefined &&
			(typeof path !== 'string' || path.length === 0 || path.length > 4096)
		) {
			return res.status(400).json({
				message: 'path must be a non-empty string no longer than 4096 characters.',
			});
		}

		const ingestionSourceId = req.query.ingestionSourceId;
		if (
			ingestionSourceId !== undefined &&
			(typeof ingestionSourceId !== 'string' || !UUID_PATTERN.test(ingestionSourceId))
		) {
			return res.status(400).json({ message: 'ingestionSourceId must be a UUID.' });
		}

		const cursor = req.query.cursor;
		if (cursor !== undefined && typeof cursor !== 'string') {
			return res.status(400).json({ message: 'cursor must be a string.' });
		}

		try {
			const result = await ArchivedEmailService.getArchivedEmailFeed({
				userId,
				path,
				ingestionSourceId,
				cursor,
				limit,
			});
			res.set('Cache-Control', 'no-store');
			return res.status(200).json(result);
		} catch (error) {
			if (error instanceof InvalidArchivedEmailFeedCursorError) {
				return res.status(400).json({ message: error.message });
			}
			console.error('Get archived email feed error:', error);
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	public getArchivedEmailChanges = async (req: Request, res: Response): Promise<Response> => {
		const userId = req.user?.sub;
		if (!userId) {
			return res.status(401).json({ message: req.t('errors.unauthorized') });
		}

		const rawLimit = req.query.limit;
		if (rawLimit !== undefined && (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit))) {
			return res.status(400).json({ message: 'limit must be an integer between 1 and 100.' });
		}

		const limit = rawLimit === undefined ? 100 : Number(rawLimit);
		if (limit < 1 || limit > 100) {
			return res.status(400).json({ message: 'limit must be an integer between 1 and 100.' });
		}

		const path = req.query.path;
		if (
			path !== undefined &&
			(typeof path !== 'string' || path.length === 0 || path.length > 4096)
		) {
			return res.status(400).json({
				message: 'path must be a non-empty string no longer than 4096 characters.',
			});
		}

		const ingestionSourceId = req.query.ingestionSourceId;
		if (
			ingestionSourceId !== undefined &&
			(typeof ingestionSourceId !== 'string' || !UUID_PATTERN.test(ingestionSourceId))
		) {
			return res.status(400).json({ message: 'ingestionSourceId must be a UUID.' });
		}

		const cursor = req.query.cursor;
		if (cursor !== undefined && typeof cursor !== 'string') {
			return res.status(400).json({ message: 'cursor must be a string.' });
		}

		try {
			const result = await ArchivedEmailService.getArchivedEmailChanges({
				userId,
				path,
				ingestionSourceId,
				cursor,
				limit,
			});
			res.set('Cache-Control', 'no-store');
			return res.status(200).json(result);
		} catch (error) {
			if (error instanceof InvalidArchivedEmailChangesCursorError) {
				return res.status(400).json({ message: error.message });
			}
			console.error('Get archived email changes error:', error);
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	public getArchivedEmails = async (req: Request, res: Response): Promise<Response> => {
		try {
			const { ingestionSourceId } = req.params;
			const page = parseInt(req.query.page as string, 10) || 1;
			const limit = parseInt(req.query.limit as string, 10) || 10;
			const userId = req.user?.sub;

			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}

			const result = await ArchivedEmailService.getArchivedEmails(
				ingestionSourceId,
				page,
				limit,
				userId
			);
			return res.status(200).json(result);
		} catch (error) {
			console.error('Get archived emails error:', error);
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	public getArchivedEmailContentById = async (req: Request, res: Response): Promise<Response> => {
		try {
			const { id } = req.params;
			const userId = req.user?.sub;

			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}

			const actor = await this.userService.findById(userId);
			if (!actor) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}

			const content = await ArchivedEmailService.getArchivedEmailContentById(
				id,
				userId,
				actor,
				req.ip || 'unknown'
			);
			if (!content) {
				return res.status(404).json({ message: req.t('archivedEmail.notFound') });
			}

			return res.status(200).json(content);
		} catch (error) {
			console.error(`Get archived email content ${req.params.id} error:`, error);
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	public getArchivedEmailById = async (req: Request, res: Response): Promise<Response> => {
		try {
			const { id } = req.params;
			const userId = req.user?.sub;

			if (!userId) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}
			const actor = await this.userService.findById(userId);
			if (!actor) {
				return res.status(401).json({ message: req.t('errors.unauthorized') });
			}

			const email = await ArchivedEmailService.getArchivedEmailById(
				id,
				userId,
				actor,
				req.ip || 'unknown'
			);
			if (!email) {
				return res.status(404).json({ message: req.t('archivedEmail.notFound') });
			}
			return res.status(200).json(email);
		} catch (error) {
			console.error(`Get archived email by id ${req.params.id} error:`, error);
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};

	public deleteArchivedEmail = async (req: Request, res: Response): Promise<Response> => {
		// Guard: return 400 if deletion is disabled in system settings before touching anything else
		try {
			checkDeletionEnabled();
		} catch (error) {
			return res.status(400).json({
				message: error instanceof Error ? error.message : req.t('errors.deletionDisabled'),
			});
		}

		const { id } = req.params;
		const userId = req.user?.sub;
		if (!userId) {
			return res.status(401).json({ message: req.t('errors.unauthorized') });
		}
		const actor = await this.userService.findById(userId);
		if (!actor) {
			return res.status(401).json({ message: req.t('errors.unauthorized') });
		}

		try {
			await ArchivedEmailService.deleteArchivedEmail(id, actor, req.ip || 'unknown');
			return res.status(204).send();
		} catch (error) {
			console.error(`Delete archived email ${req.params.id} error:`, error);
			if (error instanceof Error) {
				if (error.message === 'Archived email not found') {
					return res.status(404).json({ message: req.t('archivedEmail.notFound') });
				}
				// Retention policy / legal hold blocks are user-facing 400 errors
				if (error.message.startsWith('Deletion blocked by retention policy')) {
					return res.status(400).json({ message: error.message });
				}
				return res.status(500).json({ message: error.message });
			}
			return res.status(500).json({ message: req.t('errors.internalServerError') });
		}
	};
}
