function parseResults(text: string) {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (
		typeof value !== "object" ||
		value === null ||
		!("kind" in value) ||
		value.kind !== "web_search" ||
		!("results" in value) ||
		!Array.isArray(value.results)
	)
		return null;
	const results: Array<{ title: string; url: string; snippet: string; publishedAt?: string }> = [];
	for (const item of value.results) {
		if (
			typeof item !== "object" ||
			item === null ||
			!("url" in item) ||
			typeof item.url !== "string" ||
			!("title" in item) ||
			typeof item.title !== "string"
		)
			continue;
		let url: URL;
		try {
			url = new URL(item.url);
		} catch {
			continue;
		}
		if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) continue;
		results.push({
			url: url.href,
			title: item.title,
			snippet: "snippet" in item && typeof item.snippet === "string" ? item.snippet : "",
			publishedAt: "publishedAt" in item && typeof item.publishedAt === "string" ? item.publishedAt : undefined,
		});
	}
	return results;
}

export function SearchResults({ text }: { text: string }) {
	const results = parseResults(text);
	if (!results) return null;
	return (
		<section className="web-search-results" aria-label="搜索来源">
			{results.map((result, index) => (
				<article key={`${index}-${result.url}`}>
					<a href={result.url} target="_blank" rel="noopener noreferrer">
						{index + 1}. {result.title}
					</a>
					{result.snippet && <p>{result.snippet}</p>}
					<small>
						{new URL(result.url).hostname}
						{result.publishedAt ? ` · ${result.publishedAt}` : ""}
					</small>
				</article>
			))}
			{results.length === 0 && <p>没有符合条件的搜索结果。</p>}
		</section>
	);
}

export function ToolResult({ text }: { text: string }) {
	if (!parseResults(text)) return <pre>{text}</pre>;
	return (
		<>
			<SearchResults text={text} />
			<details>
				<summary>原始工具结果</summary>
				<pre>{text}</pre>
			</details>
		</>
	);
}
