<script lang="ts">
	import type { PageData } from './$types';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Select from '$lib/components/ui/select';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Badge } from '$lib/components/ui/badge';
	import { Card } from '$lib/components/ui/card';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import type { MatchingStrategy, SearchHit } from '@open-archiver/types';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import * as Alert from '$lib/components/ui/alert/index.js';
	import { t } from '$lib/translations';
	import * as Pagination from '$lib/components/ui/pagination/index.js';
	import ChevronLeft from 'lucide-svelte/icons/chevron-left';
	import ChevronRight from 'lucide-svelte/icons/chevron-right';
	import CircleHelp from 'lucide-svelte/icons/circle-help';
	import Filter from 'lucide-svelte/icons/filter';

	let { data }: { data: PageData } = $props();
	let searchResult = $derived(data.searchResult);
	let keywords = $state(data.keywords || '');
	let page = $derived(data.page);
	let error = $derived(data.error);
	let matchingStrategy: MatchingStrategy = $state(
		(data.matchingStrategy as MatchingStrategy) || 'last'
	);

	const strategies = [
		{ value: 'last', label: $t('app.search.strategy_fuzzy') },
		{ value: 'all', label: $t('app.search.strategy_verbatim') },
		{ value: 'frequency', label: $t('app.search.strategy_frequency') },
	];

	type PreviewFilter = {
		label: string;
		value: string;
	};

	type ResultSnippet = {
		label: string;
		html: string;
	};

	type ResultSummary = {
		matchLabels: string[];
		snippets: ResultSnippet[];
		totalSnippetCount: number;
	};

	const operatorChips = [
		{ label: 'From', token: 'from:' },
		{ label: 'To', token: 'to:' },
		{ label: 'Domain', token: 'domain:' },
		{ label: 'After', token: 'after:' },
		{ label: 'Before', token: 'before:' },
		{ label: 'Attachment', token: 'has:attachment' },
	];

	const helpExamples = [
		'from:alice@example.com invoice',
		'to:bob@example.com contract',
		'domain:vendor.com renewal',
		'after:2024-01-01 before:2024-12-31',
		'has:attachment receipt',
	];

	const triggerContent = $derived(
		strategies.find((s) => s.value === matchingStrategy)?.label ??
			$t('app.search.select_strategy')
	);
	const parsedPreview = $derived(parseSearchQueryPreview(keywords));

	let isMounted = $state(false);
	let searchInput = $state<HTMLInputElement | null>(null);
	onMount(() => {
		isMounted = true;
	});

	function shadowRender(node: HTMLElement, html: string | undefined) {
		if (html === undefined) return;

		const shadow = node.attachShadow({ mode: 'open' });
		const style = document.createElement('style');
		style.textContent = `em { background-color: #fef08a; border-radius: 0.2rem; color: inherit; font-style: normal; padding: 0 0.125rem; }`;
		shadow.appendChild(style);
		const content = document.createElement('div');
		content.innerHTML = html;
		shadow.appendChild(content);

		return {
			update(newHtml: string | undefined) {
				if (newHtml === undefined) return;
				content.innerHTML = newHtml;
			},
		};
	}

	function handleSearch(e: SubmitEvent) {
		e.preventDefault();
		const params = new URLSearchParams();
		params.set('keywords', keywords);
		params.set('page', '1');
		params.set('matchingStrategy', matchingStrategy);
		goto(`/dashboard/search?${params.toString()}`, { keepFocus: true });
	}

	function focusSearch() {
		setTimeout(() => {
			searchInput?.focus();
			searchInput?.setSelectionRange(keywords.length, keywords.length);
		}, 0);
	}

	function insertToken(token: string) {
		const trimmed = keywords.trim();
		keywords = trimmed ? `${trimmed} ${token}` : token;
		focusSearch();
	}

	function applyQuery(query: string) {
		keywords = query;
		focusSearch();
	}

	function formatDateDaysAgo(days: number) {
		const date = new Date();
		date.setDate(date.getDate() - days);
		return date.toISOString().slice(0, 10);
	}

	function parseSearchQueryPreview(query: string): {
		filters: PreviewFilter[];
		query: string;
	} {
		const filters: PreviewFilter[] = [];
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
			const filter = previewFilterFor(operator, value);

			if (filter) {
				filters.push(filter);
			} else {
				remainingParts.push(`${leadingWhitespace}${operatorText}`);
			}

			cursor = match.index + match[0].length;
		}

		remainingParts.push(query.slice(cursor));

		return {
			filters,
			query: remainingParts.join(' ').replace(/\s+/g, ' ').trim(),
		};
	}

	function previewFilterFor(operator: string, value: string): PreviewFilter | null {
		if (!value) return null;

		switch (operator) {
			case 'from':
				return { label: 'From', value };
			case 'to':
				return { label: 'To', value };
			case 'domain':
				return { label: 'Domain', value };
			case 'after':
				return { label: 'After', value };
			case 'before':
				return { label: 'Before', value };
			case 'has':
				return value.toLowerCase() === 'attachment' ||
					value.toLowerCase() === 'attachments'
					? { label: 'Has', value: 'attachment' }
					: null;
			default:
				return null;
		}
	}

	function searchUrl(targetPage: number) {
		const params = new URLSearchParams();
		params.set('keywords', keywords);
		params.set('page', String(targetPage));
		params.set('matchingStrategy', matchingStrategy);
		return `/dashboard/search?${params.toString()}`;
	}

	function getHighlightedSnippets(text: string | undefined, snippetLength = 80): string[] {
		if (!text || !text.includes('<em>')) {
			return [];
		}

		const snippets: string[] = [];
		const regex = /<em>.*?<\/em>/g;
		let match;
		let lastIndex = 0;

		while ((match = regex.exec(text)) !== null) {
			if (match.index < lastIndex) {
				continue;
			}

			const matchIndex = match.index;
			const matchLength = match[0].length;

			const start = Math.max(0, matchIndex - snippetLength);
			const end = Math.min(text.length, matchIndex + matchLength + snippetLength);

			lastIndex = end;

			let snippet = text.substring(start, end);

			// Then, balance them
			const openCount = (snippet.match(/<em/g) || []).length;
			const closeCount = (snippet.match(/<\/em>/g) || []).length;

			if (openCount > closeCount) {
				snippet += '</em>';
			}

			if (closeCount > openCount) {
				snippet = '<em>' + snippet;
			}

			// Finally, add ellipsis
			if (start > 0) {
				snippet = '...' + snippet;
			}
			if (end < text.length) {
				snippet += '...';
			}

			snippets.push(snippet);
		}

		return snippets;
	}

	function hasHighlight(value: unknown): boolean {
		if (typeof value === 'string') {
			return value.includes('<em>');
		}

		if (Array.isArray(value)) {
			return value.some(hasHighlight);
		}

		if (value && typeof value === 'object') {
			return Object.values(value as Record<string, unknown>).some(hasHighlight);
		}

		return false;
	}

	function compactList(values: string[] | undefined, maxVisible = 2): string {
		if (!values || values.length === 0) {
			return '';
		}

		const visible = values.slice(0, maxVisible).join(', ');
		const extraCount = values.length - maxVisible;

		return extraCount > 0 ? `${visible} +${extraCount}` : visible;
	}

	function stripMarkup(value: string | undefined): string {
		return value?.replace(/<[^>]+>/g, '') ?? '';
	}

	function formatTimestamp(timestamp: number): string {
		return new Date(timestamp).toLocaleString(undefined, {
			dateStyle: 'medium',
			timeStyle: 'short',
		});
	}

	function resultSummary(hit: SearchHit): ResultSummary {
		const formatted = hit._formatted || {};
		const matchLabels = new Set<string>();
		const snippets: ResultSnippet[] = [];

		if (hasHighlight(formatted.subject)) matchLabels.add('Subject');
		if (hasHighlight(formatted.from)) matchLabels.add('From');
		if (hasHighlight(formatted.to)) matchLabels.add('To');

		const bodySnippets = getHighlightedSnippets(formatted.body, 96);
		if (bodySnippets.length > 0) {
			matchLabels.add('Body');
			for (const snippet of bodySnippets) {
				snippets.push({ label: 'Body', html: snippet });
			}
		}

		if (formatted.attachments) {
			for (const [index, attachment] of formatted.attachments.entries()) {
				if (!attachment) continue;

				if (hasHighlight(attachment)) {
					matchLabels.add('Attachment');
				}

				for (const snippet of getHighlightedSnippets(attachment.content, 96)) {
					const filename =
						hit.attachments?.[index]?.filename || stripMarkup(attachment.filename);
					snippets.push({
						label: filename ? `Attachment: ${filename}` : 'Attachment',
						html: snippet,
					});
				}
			}
		}

		return {
			matchLabels: Array.from(matchLabels),
			snippets: snippets.slice(0, 2),
			totalSnippetCount: snippets.length,
		};
	}
</script>

<svelte:head>
	<title>{$t('app.search.title')} | Open Archiver</title>
	<meta name="description" content={$t('app.search.description')} />
</svelte:head>

<div class="container mx-auto p-4 md:p-8">
	<h1 class="mb-4 text-2xl font-bold">{$t('app.search.email_search')}</h1>

	<form onsubmit={(e) => handleSearch(e)} class="mb-8 flex flex-col space-y-3">
		<div class="flex items-center gap-2">
			<Input
				type="search"
				name="keywords"
				placeholder={$t('app.search.placeholder')}
				class=" h-12 flex-grow"
				bind:value={keywords}
				bind:ref={searchInput}
			/>
			<Button type="submit" class="h-12 cursor-pointer"
				>{$t('app.search.search_button')}</Button
			>
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					<Button
						type="button"
						variant="outline"
						size="icon"
						class="h-12 w-12"
						aria-label="Search help"
					>
						<CircleHelp class="h-4 w-4" />
					</Button>
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end" class="w-80 p-3">
					<div class="space-y-3">
						<div class="flex items-center gap-2 text-sm font-semibold">
							<Filter class="h-4 w-4" />
							<span>Filter syntax</span>
						</div>
						<div class="grid gap-2 text-sm">
							{#each helpExamples as example}
								<button
									type="button"
									class="hover:bg-accent flex rounded-md px-2 py-1.5 text-left font-mono text-xs"
									onclick={() => applyQuery(example)}
								>
									{example}
								</button>
							{/each}
						</div>
					</div>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		</div>

		<div class="flex flex-wrap items-center gap-2">
			{#each operatorChips as chip}
				<Button
					type="button"
					variant="outline"
					size="sm"
					class="h-8"
					onclick={() => insertToken(chip.token)}
				>
					{chip.label}
				</Button>
			{/each}
			<Button
				type="button"
				variant="secondary"
				size="sm"
				class="h-8"
				onclick={() => insertToken(`after:${formatDateDaysAgo(30)}`)}
			>
				Last 30 days
			</Button>
			<Button
				type="button"
				variant="secondary"
				size="sm"
				class="h-8"
				onclick={() => insertToken(`after:${formatDateDaysAgo(365)}`)}
			>
				Last year
			</Button>
		</div>

		{#if parsedPreview.filters.length > 0 || parsedPreview.query}
			<div class="bg-muted/30 rounded-md border p-3 text-sm">
				<div class="flex flex-wrap items-center gap-2">
					{#if parsedPreview.filters.length > 0}
						<span class="text-muted-foreground text-xs font-medium">Filters</span>
						{#each parsedPreview.filters as filter}
							<Badge variant="secondary">
								{filter.label}: {filter.value}
							</Badge>
						{/each}
					{/if}
					{#if parsedPreview.query}
						<span class="text-muted-foreground text-xs font-medium">Search text</span>
						<Badge variant="outline">{parsedPreview.query}</Badge>
					{/if}
				</div>
			</div>
		{/if}

		<div class="flex flex-wrap items-center gap-2">
			<span class="text-xs font-medium">{$t('app.search.search_options')}</span>
			<Select.Root type="single" name="matchingStrategy" bind:value={matchingStrategy}>
				<Select.Trigger class=" w-[180px] cursor-pointer">
					{triggerContent}
				</Select.Trigger>
				<Select.Content>
					{#each strategies as strategy (strategy.value)}
						<Select.Item
							value={strategy.value}
							label={strategy.label}
							class="cursor-pointer"
						>
							{strategy.label}
						</Select.Item>
					{/each}
				</Select.Content>
			</Select.Root>
		</div>
	</form>

	{#if error}
		<Alert.Root variant="destructive">
			<CircleAlertIcon class="size-4" />
			<Alert.Title>{$t('app.search.error')}</Alert.Title>
			<Alert.Description>{error}</Alert.Description>
		</Alert.Root>
	{/if}

	{#if searchResult}
		<p class="text-muted-foreground mb-4">
			{#if searchResult.total > 0}
				{$t('app.search.found_results_in', {
					total: searchResult.total,
					seconds: searchResult.processingTimeMs / 1000,
				} as any)}
			{:else}
				{$t('app.search.found_results', { total: searchResult.total } as any)}
			{/if}
		</p>

		<div class="grid gap-2">
			{#each searchResult.hits as hit}
				{@const _formatted = hit._formatted || {}}
				{@const summary = resultSummary(hit)}
				<a href="/dashboard/archived-emails/{hit.id}" class="group block">
					<Card
						class="border-muted/70 gap-0 py-0 transition-colors group-hover:bg-muted/40"
					>
						<div class="space-y-3 p-4">
							<div
								class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between"
							>
								<div class="min-w-0 space-y-1.5">
									{#if !isMounted}
										<Skeleton class="h-5 w-3/4" />
									{:else}
										<div
											class="text-foreground min-w-0 break-words text-base font-semibold leading-snug"
											use:shadowRender={_formatted.subject ||
												hit.subject ||
												'(No subject)'}
										></div>
									{/if}

									<div
										class="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
									>
										<span class="inline-flex min-w-0 items-center gap-1">
											<span class="text-foreground/80 font-medium"
												>{$t('app.search.from')}:</span
											>
											{#if !isMounted}
												<Skeleton class="h-4 w-36" />
											{:else}
												<span
													class="inline-block min-w-0 truncate"
													use:shadowRender={_formatted.from || hit.from}
												></span>
											{/if}
										</span>
										<span class="inline-flex min-w-0 items-center gap-1">
											<span class="text-foreground/80 font-medium"
												>{$t('app.search.to')}:</span
											>
											{#if !isMounted}
												<Skeleton class="h-4 w-36" />
											{:else}
												<span
													class="inline-block min-w-0 truncate"
													use:shadowRender={compactList(
														_formatted.to || hit.to
													)}
												></span>
											{/if}
										</span>
										{#if !isMounted}
											<Skeleton class="h-4 w-32" />
										{:else}
											<span class="shrink-0">{formatTimestamp(hit.timestamp)}</span>
										{/if}
									</div>
								</div>

								{#if summary.matchLabels.length > 0}
									<div
										class="flex shrink-0 flex-wrap gap-1.5 md:max-w-56 md:justify-end"
									>
										{#each summary.matchLabels as label}
											<Badge variant="outline" class="h-5 px-1.5 text-[11px]">
												{label}
											</Badge>
										{/each}
									</div>
								{/if}
							</div>

							{#if summary.snippets.length > 0}
								<div class="border-border/60 space-y-2 border-t pt-3">
									{#each summary.snippets as snippet}
										<div
											class="grid gap-1 md:grid-cols-[7rem_minmax(0,1fr)] md:gap-3"
										>
											<span
												class="text-muted-foreground truncate text-xs font-medium"
											>
												{snippet.label}
											</span>
											{#if !isMounted}
												<Skeleton class="h-4 w-full" />
											{:else}
												<p
													class="text-muted-foreground min-w-0 break-words font-mono text-xs leading-relaxed"
													use:shadowRender={snippet.html}
												></p>
											{/if}
										</div>
									{/each}

									{#if summary.totalSnippetCount > summary.snippets.length}
										<Badge variant="secondary" class="w-fit text-xs">
											+{summary.totalSnippetCount - summary.snippets.length} more
											matches
										</Badge>
									{/if}
								</div>
							{/if}
						</div>
					</Card>
				</a>
			{/each}
		</div>

		{#if searchResult.total > searchResult.limit}
			<div class="mt-8">
				<Pagination.Root count={searchResult.total} perPage={searchResult.limit} {page}>
					{#snippet children({ pages, currentPage })}
						<Pagination.Content>
							<Pagination.Item>
								<a href={searchUrl(currentPage - 1)}>
									<Pagination.PrevButton>
										<ChevronLeft class="h-4 w-4" />
										<span class="hidden sm:block">{$t('app.search.prev')}</span>
									</Pagination.PrevButton>
								</a>
							</Pagination.Item>
							{#each pages as page (page.key)}
								{#if page.type === 'ellipsis'}
									<Pagination.Item>
										<Pagination.Ellipsis />
									</Pagination.Item>
								{:else}
									<Pagination.Item>
										<a href={searchUrl(page.value)}>
											<Pagination.Link
												{page}
												isActive={currentPage === page.value}
											>
												{page.value}
											</Pagination.Link>
										</a>
									</Pagination.Item>
								{/if}
							{/each}
							<Pagination.Item>
								<a href={searchUrl(currentPage + 1)}>
									<Pagination.NextButton>
										<span class="hidden sm:block">{$t('app.search.next')}</span>
										<ChevronRight class="h-4 w-4" />
									</Pagination.NextButton>
								</a>
							</Pagination.Item>
						</Pagination.Content>
					{/snippet}
				</Pagination.Root>
			</div>
		{/if}
	{/if}
</div>
