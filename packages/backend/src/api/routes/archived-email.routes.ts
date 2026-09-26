import { Router } from 'express';
import { ArchivedEmailController } from '../controllers/archived-email.controller';
import { requireAuth } from '../middleware/requireAuth';
import { requirePermission } from '../middleware/requirePermission';
import { AuthService } from '../../services/AuthService';

export const createArchivedEmailRouter = (
	archivedEmailController: ArchivedEmailController,
	authService: AuthService
): Router => {
	const router = Router();

	// Secure all routes in this module
	router.use(requireAuth(authService));

	/**
	 * @openapi
	 * /v1/archived-emails:
	 *   get:
	 *     summary: Browse the archived email feed
	 *     description: Returns a read-only, newest-first cursor-paginated feed across archived emails the caller may read. The optional `path` parameter is an exact match, for example `ben.hoff@skan.ai/Inbox/`.
	 *     operationId: getArchivedEmailFeed
	 *     tags:
	 *       - Archived Emails
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: path
	 *         in: query
	 *         required: false
	 *         description: Exact archived mailbox path to include.
	 *         schema:
	 *           type: string
	 *           example: "ben.hoff@skan.ai/Inbox/"
	 *       - name: ingestionSourceId
	 *         in: query
	 *         required: false
	 *         description: Optionally restrict results to one ingestion source and its merge group.
	 *         schema:
	 *           type: string
	 *           format: uuid
	 *       - name: limit
	 *         in: query
	 *         required: false
	 *         description: Number of messages to return, from 1 to 100.
	 *         schema:
	 *           type: integer
	 *           default: 25
	 *           minimum: 1
	 *           maximum: 100
	 *       - name: cursor
	 *         in: query
	 *         required: false
	 *         description: Opaque `nextCursor` returned by the previous page.
	 *         schema:
	 *           type: string
	 *     responses:
	 *       '200':
	 *         description: Newest-first message feed.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               type: object
	 *               required: [items, nextCursor, hasMore]
	 *               properties:
	 *                 items:
	 *                   type: array
	 *                   items:
	 *                     $ref: '#/components/schemas/ArchivedEmailFeedItem'
	 *                 nextCursor:
	 *                   type: string
	 *                   nullable: true
	 *                 hasMore:
	 *                   type: boolean
	 *       '400':
	 *         description: Invalid limit, path, ingestion source, or cursor.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               $ref: '#/components/schemas/ErrorMessage'
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 */
	router.get(
		'/',
		requirePermission('read', 'archive'),
		archivedEmailController.getArchivedEmailFeed
	);

	/**
	 * @openapi
	 * /v1/archived-emails/changes:
	 *   get:
	 *     summary: Poll for newly archived emails
	 *     description: Establishes or advances a durable, read-only checkpoint ordered by a transactional change log. When `cursor` is omitted, the response contains no items and returns a checkpoint at the current committed change-log position. Poll again with that cursor to receive newly archived messages in commit order, including inserts that were still in flight at initialization. A cursor must be reused by the same authenticated user with the same filters that created it.
	 *     operationId: getArchivedEmailChanges
	 *     tags:
	 *       - Archived Emails
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: path
	 *         in: query
	 *         required: false
	 *         description: Exact archived mailbox path to include.
	 *         schema:
	 *           type: string
	 *           example: "ben.hoff@skan.ai/Inbox/"
	 *       - name: ingestionSourceId
	 *         in: query
	 *         required: false
	 *         description: Optionally restrict results to one ingestion source and its merge group.
	 *         schema:
	 *           type: string
	 *           format: uuid
	 *       - name: limit
	 *         in: query
	 *         required: false
	 *         description: Maximum number of changes to return, from 1 to 100.
	 *         schema:
	 *           type: integer
	 *           default: 100
	 *           minimum: 1
	 *           maximum: 100
	 *       - name: cursor
	 *         in: query
	 *         required: false
	 *         description: Opaque `nextCursor` from the previous changes response. Omit it only to initialize polling.
	 *         schema:
	 *           type: string
	 *     responses:
	 *       '200':
	 *         description: Newly archived messages in change-log order and the next polling checkpoint.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               type: object
	 *               required: [items, nextCursor, hasMore]
	 *               properties:
	 *                 items:
	 *                   type: array
	 *                   items:
	 *                     $ref: '#/components/schemas/ArchivedEmailFeedItem'
	 *                 nextCursor:
	 *                   type: string
	 *                 hasMore:
	 *                   type: boolean
	 *       '400':
	 *         description: Invalid input, invalid cursor, or cursor filters do not match.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               $ref: '#/components/schemas/ErrorMessage'
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 */
	router.get(
		'/changes',
		requirePermission('read', 'archive'),
		archivedEmailController.getArchivedEmailChanges
	);

	/**
	 * @openapi
	 * /v1/archived-emails/ingestion-source/{ingestionSourceId}:
	 *   get:
	 *     summary: List archived emails for an ingestion source
	 *     description: Returns a paginated list of archived emails belonging to the specified ingestion source. Requires `read:archive` permission.
	 *     operationId: getArchivedEmails
	 *     tags:
	 *       - Archived Emails
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: ingestionSourceId
	 *         in: path
	 *         required: true
	 *         description: The ID of the ingestion source to retrieve emails for.
	 *         schema:
	 *           type: string
	 *           example: "clx1y2z3a0000b4d2"
	 *       - name: page
	 *         in: query
	 *         required: false
	 *         description: Page number for pagination.
	 *         schema:
	 *           type: integer
	 *           default: 1
	 *           example: 1
	 *       - name: limit
	 *         in: query
	 *         required: false
	 *         description: Number of items per page.
	 *         schema:
	 *           type: integer
	 *           default: 10
	 *           example: 10
	 *     responses:
	 *       '200':
	 *         description: Paginated list of archived emails.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               $ref: '#/components/schemas/PaginatedArchivedEmails'
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '500':
	 *         $ref: '#/components/responses/InternalServerError'
	 */
	router.get(
		'/ingestion-source/:ingestionSourceId',
		requirePermission('read', 'archive'),
		archivedEmailController.getArchivedEmails
	);

	/**
	 * @openapi
	 * /v1/archived-emails/{id}/content:
	 *   get:
	 *     summary: Get structured archived email content
	 *     description: Parses one archived EML message and returns normalized headers, text, HTML, and attachment metadata without attachment bytes. Requires `read:archive` permission.
	 *     operationId: getArchivedEmailContentById
	 *     tags:
	 *       - Archived Emails
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: id
	 *         in: path
	 *         required: true
	 *         schema:
	 *           type: string
	 *           format: uuid
	 *     responses:
	 *       '200':
	 *         description: Parsed archived email content.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               $ref: '#/components/schemas/ArchivedEmailContent'
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '404':
	 *         $ref: '#/components/responses/NotFound'
	 */
	router.get(
		'/:id/content',
		requirePermission('read', 'archive'),
		archivedEmailController.getArchivedEmailContentById
	);

	/**
	 * @openapi
	 * /v1/archived-emails/{id}:
	 *   get:
	 *     summary: Get a single archived email
	 *     description: Retrieves the full details of a single archived email by ID, including attachments and thread. Requires `read:archive` permission.
	 *     operationId: getArchivedEmailById
	 *     tags:
	 *       - Archived Emails
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: id
	 *         in: path
	 *         required: true
	 *         description: The ID of the archived email.
	 *         schema:
	 *           type: string
	 *           example: "clx1y2z3a0000b4d2"
	 *     responses:
	 *       '200':
	 *         description: Archived email details.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               $ref: '#/components/schemas/ArchivedEmail'
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '404':
	 *         $ref: '#/components/responses/NotFound'
	 *       '500':
	 *         $ref: '#/components/responses/InternalServerError'
	 *   delete:
	 *     summary: Delete an archived email
	 *     description: Permanently deletes an archived email by ID. Deletion must be enabled in system settings and the email must not be on legal hold. Requires `delete:archive` permission.
	 *     operationId: deleteArchivedEmail
	 *     tags:
	 *       - Archived Emails
	 *     security:
	 *       - bearerAuth: []
	 *       - apiKeyAuth: []
	 *     parameters:
	 *       - name: id
	 *         in: path
	 *         required: true
	 *         description: The ID of the archived email to delete.
	 *         schema:
	 *           type: string
	 *           example: "clx1y2z3a0000b4d2"
	 *     responses:
	 *       '204':
	 *         description: Email deleted successfully. No content returned.
	 *       '400':
	 *         description: Deletion is disabled in system settings, or the email is blocked by a retention policy / legal hold.
	 *         content:
	 *           application/json:
	 *             schema:
	 *               $ref: '#/components/schemas/ErrorMessage'
	 *       '401':
	 *         $ref: '#/components/responses/Unauthorized'
	 *       '404':
	 *         $ref: '#/components/responses/NotFound'
	 *       '500':
	 *         $ref: '#/components/responses/InternalServerError'
	 */
	router.get(
		'/:id',
		requirePermission('read', 'archive'),
		archivedEmailController.getArchivedEmailById
	);

	router.delete(
		'/:id',
		requirePermission('delete', 'archive'),
		archivedEmailController.deleteArchivedEmail
	);

	return router;
};
