import { Index, MeiliSearch, SearchParams } from 'meilisearch';
import { config } from '../config';
import type {
	SearchQuery,
	SearchResult,
	EmailDocument,
	TopSender,
	User,
} from '@open-archiver/types';
import { FilterBuilder } from './FilterBuilder';
import { AuditService } from './AuditService';
import { IngestionService } from './IngestionService';

type ParsedQuery = {
	query: string;
	filterParts: string[];
};

function normalizeDomain(value: string): string {
	return value.trim().toLowerCase().replace(/^@/, '');
}

function normalizeEmail(value: string): string {
	return value.trim().toLowerCase();
}

function quoteFilterValue(value: string): string {
	return JSON.stringify(value);
}

function parseDateBoundary(value: string, boundary: 'start' | 'end'): number | null {
	const trimmed = value.trim();
	const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);

	if (dateOnly) {
		const [, year, month, day] = dateOnly;
		return boundary === 'start'
			? Date.UTC(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0)
			: Date.UTC(Number(year), Number(month) - 1, Number(day), 23, 59, 59, 999);
	}

	const parsed = Date.parse(trimmed);
	return Number.isNaN(parsed) ? null : parsed;
}

export class SearchService {
	private client: MeiliSearch;
	private auditService: AuditService;

	constructor() {
		this.client = new MeiliSearch({
			host: config.search.host,
			apiKey: config.search.apiKey,
		});
		this.auditService = new AuditService();
	}

	public async getIndex<T extends Record<string, any>>(name: string): Promise<Index<T>> {
		return this.client.index<T>(name);
	}

	public async addDocuments<T extends Record<string, any>>(
		indexName: string,
		documents: T[],
		primaryKey?: string
	) {
		const index = await this.getIndex<T>(indexName);
		if (primaryKey) {
			index.update({ primaryKey });
		}
		return index.addDocuments(documents);
	}

	public async search<T extends Record<string, any>>(
		indexName: string,
		query: string,
		options?: any
	) {
		const index = await this.getIndex<T>(indexName);
		return index.search(query, options);
	}

	public async deleteDocuments(indexName: string, ids: string[]) {
		const index = await this.getIndex(indexName);
		return index.deleteDocuments(ids);
	}

	public async deleteDocumentsByFilter(indexName: string, filter: string | string[]) {
		const index = await this.getIndex(indexName);
		return index.deleteDocuments({ filter });
	}

	public async searchEmails(
		dto: SearchQuery,
		userId: string,
		actorIp: string
	): Promise<SearchResult> {
		const { query, filters, page = 1, limit = 10, matchingStrategy = 'last' } = dto;
		const index = await this.getIndex<EmailDocument>('emails');
		const filterableAttributes = await this.getFilterableAttributes('emails');
		const parsedQuery = this.parseQueryOperators(query, filterableAttributes);

		const searchParams: SearchParams = {
			limit,
			offset: (page - 1) * limit,
			attributesToHighlight: ['*'],
			showMatchesPosition: true,
			sort: ['timestamp:desc'],
			matchingStrategy,
		};

		if (filters) {
			const filterParts: string[] = [];
			for (const [key, value] of Object.entries(filters)) {
				// Expand ingestionSourceId to the full merge group
				if (key === 'ingestionSourceId' && typeof value === 'string') {
					const groupIds = await IngestionService.findGroupSourceIds(value);
					if (groupIds.length === 1) {
						filterParts.push(`ingestionSourceId = ${quoteFilterValue(groupIds[0])}`);
					} else {
						const inList = groupIds.map(quoteFilterValue).join(', ');
						filterParts.push(`ingestionSourceId IN [${inList}]`);
					}
				} else if (typeof value === 'string') {
					filterParts.push(`${key} = ${quoteFilterValue(value)}`);
				} else {
					filterParts.push(`${key} = ${value}`);
				}
			}
			searchParams.filter = filterParts.join(' AND ');
		}

		if (parsedQuery.filterParts.length > 0) {
			const operatorFilter = parsedQuery.filterParts.join(' AND ');
			searchParams.filter = searchParams.filter
				? `${searchParams.filter} AND ${operatorFilter}`
				: operatorFilter;
		}

		// Create a filter based on the user's permissions.
		// This ensures that the user can only search for emails they are allowed to see.
		const { searchFilter } = await FilterBuilder.create(userId, 'archive', 'read');
		if (searchFilter) {
			// Convert the MongoDB-style filter from CASL to a MeiliSearch filter string.
			if (searchParams.filter) {
				// If there are existing filters, append the access control filter.
				searchParams.filter = `${searchParams.filter} AND ${searchFilter}`;
			} else {
				// Otherwise, just use the access control filter.
				searchParams.filter = searchFilter;
			}
		}
		// console.log('searchParams', searchParams);
		const searchResults = await index.search(parsedQuery.query, searchParams);

		await this.auditService.createAuditLog({
			actorIdentifier: userId,
			actionType: 'SEARCH',
			targetType: 'ArchivedEmail',
			targetId: '',
			actorIp,
			details: {
				query,
				parsedQuery: parsedQuery.query,
				operatorFilters: parsedQuery.filterParts,
				filters,
				page,
				limit,
				matchingStrategy,
			},
		});

		return {
			hits: searchResults.hits,
			total: searchResults.estimatedTotalHits ?? searchResults.hits.length,
			page,
			limit,
			totalPages: Math.ceil(
				(searchResults.estimatedTotalHits ?? searchResults.hits.length) / limit
			),
			processingTimeMs: searchResults.processingTimeMs,
		};
	}

	private parseQueryOperators(query: string, filterableAttributes: Set<string>): ParsedQuery {
		const filterParts: string[] = [];
		const remainingParts: string[] = [];
		const operatorPattern =
			/(^|\s)(from|to|domain|after|before|has):(?:"([^"]*)"|'([^']*)'|(\S+))/gi;
		let cursor = 0;
		let match: RegExpExecArray | null;

		while ((match = operatorPattern.exec(query)) !== null) {
			remainingParts.push(query.slice(cursor, match.index));

			const leadingWhitespace = match[1] || '';
			const operatorText = match[0].slice(leadingWhitespace.length);
			const operator = match[2].toLowerCase();
			const value = (match[3] ?? match[4] ?? match[5] ?? '').trim();
			const filter = this.buildOperatorFilter(operator, value, filterableAttributes);

			if (filter) {
				filterParts.push(filter);
			} else {
				const fallbackQuery = this.buildOperatorFallbackQuery(operator, value);
				remainingParts.push(
					fallbackQuery
						? `${leadingWhitespace}${fallbackQuery}`
						: `${leadingWhitespace}${operatorText}`
				);
			}

			cursor = match.index + match[0].length;
		}

		remainingParts.push(query.slice(cursor));

		return {
			query: remainingParts.join(' ').replace(/\s+/g, ' ').trim(),
			filterParts,
		};
	}

	private buildOperatorFilter(
		operator: string,
		value: string,
		filterableAttributes: Set<string>
	): string | null {
		if (!value) {
			return null;
		}

		switch (operator) {
			case 'from': {
				const normalizedValue = normalizeEmail(value);
				if (normalizedValue.includes('@') && filterableAttributes.has('from')) {
					return `from = ${quoteFilterValue(normalizedValue)}`;
				}
				const domain = normalizeDomain(normalizedValue);
				return domain.includes('.') && filterableAttributes.has('fromDomain')
					? `fromDomain = ${quoteFilterValue(domain)}`
					: null;
			}
			case 'to': {
				const normalizedValue = normalizeEmail(value);
				if (normalizedValue.includes('@') && filterableAttributes.has('to')) {
					return `to = ${quoteFilterValue(normalizedValue)}`;
				}
				const domain = normalizeDomain(normalizedValue);
				return domain.includes('.') && filterableAttributes.has('recipientDomains')
					? `recipientDomains = ${quoteFilterValue(domain)}`
					: null;
			}
			case 'domain': {
				const domain = normalizeDomain(value);
				return domain.includes('.') && filterableAttributes.has('participantDomains')
					? `participantDomains = ${quoteFilterValue(domain)}`
					: null;
			}
			case 'after': {
				const timestamp = parseDateBoundary(value, 'start');
				return timestamp === null || !filterableAttributes.has('timestamp')
					? null
					: `timestamp >= ${timestamp}`;
			}
			case 'before': {
				const timestamp = parseDateBoundary(value, 'end');
				return timestamp === null || !filterableAttributes.has('timestamp')
					? null
					: `timestamp <= ${timestamp}`;
			}
			case 'has': {
				const normalizedValue = value.trim().toLowerCase();
				if (
					(normalizedValue === 'attachment' || normalizedValue === 'attachments') &&
					filterableAttributes.has('hasAttachments') &&
					filterableAttributes.has('attachments.filename')
				) {
					return `(hasAttachments = true OR attachments.filename EXISTS)`;
				}
				return null;
			}
			default:
				return null;
		}
	}

	private buildOperatorFallbackQuery(operator: string, value: string): string | null {
		if (operator === 'from' || operator === 'to' || operator === 'domain') {
			return value;
		}

		return null;
	}

	private async getFilterableAttributes(indexName: string): Promise<Set<string>> {
		const headers: Record<string, string> = {};

		if (config.search.apiKey) {
			headers.Authorization = `Bearer ${config.search.apiKey}`;
		}

		try {
			const response = await fetch(
				`${config.search.host}/indexes/${indexName}/settings/filterable-attributes`,
				{ headers }
			);

			if (!response.ok) {
				return new Set();
			}

			const attributes = (await response.json()) as string[];
			return new Set(attributes);
		} catch {
			return new Set();
		}
	}

	public async getTopSenders(limit = 10): Promise<TopSender[]> {
		const index = await this.getIndex<EmailDocument>('emails');
		const searchResults = await index.search('', {
			facets: ['from'],
			limit: 0,
		});

		if (!searchResults.facetDistribution?.from) {
			return [];
		}

		// Sort and take top N
		const sortedSenders = Object.entries(searchResults.facetDistribution.from)
			.sort(([, countA], [, countB]) => countB - countA)
			.slice(0, limit)
			.map(([sender, count]) => ({ sender, count }));

		return sortedSenders;
	}

	public async configureEmailIndex() {
		const index = await this.getIndex('emails');
		await index.updateSettings({
			searchableAttributes: [
				'subject',
				'body',
				'from',
				'fromDomain',
				'to',
				'toDomains',
				'cc',
				'ccDomains',
				'bcc',
				'bccDomains',
				'recipientDomains',
				'participantDomains',
				'attachments.filename',
				'attachments.content',
				'userEmail',
			],
			filterableAttributes: [
				'from',
				'fromDomain',
				'to',
				'toDomains',
				'cc',
				'ccDomains',
				'bcc',
				'bccDomains',
				'recipientDomains',
				'participantDomains',
				'timestamp',
				'ingestionSourceId',
				'userEmail',
				'hasAttachments',
				'attachments.filename',
			],
			sortableAttributes: ['timestamp'],
		});
	}
}
