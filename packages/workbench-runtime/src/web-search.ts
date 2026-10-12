export interface WebSearchInput {
	query: string;
	allowed_domains?: string[];
	blocked_domains?: string[];
	max_results?: number;
}

export interface WebSearchResult {
	kind: "web_search";
	query: string;
	provider: string;
	searchedAt: string;
	results: { title: string; url: string; snippet: string; publishedAt?: string }[];
}

export interface RuntimeWebSearch {
	status(): Promise<{ configured: boolean; provider: string; modelId: string; endpoint: string }>;
	search(input: WebSearchInput, signal?: AbortSignal): Promise<WebSearchResult>;
}
