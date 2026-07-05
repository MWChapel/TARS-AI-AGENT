import { config } from '../config';

export interface SearchResult {
  title:   string;
  snippet: string;
  url:     string;
}

export async function webSearch(query: string, maxResults = 5): Promise<SearchResult[]> {
  if (config.search.braveApiKey) {
    return braveSearch(query, maxResults);
  }
  return duckduckgoSearch(query, maxResults);
}

// ── Brave Search (optional, better quality) ───────────────────────────────────

interface BraveResult { title: string; description: string; url: string; }
interface BraveResponse { web?: { results?: BraveResult[] } }

async function braveSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': config.search.braveApiKey! },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Brave search HTTP ${res.status}`);
  const data = await res.json() as BraveResponse;
  return (data.web?.results ?? []).slice(0, maxResults).map(r => ({
    title:   r.title,
    snippet: r.description,
    url:     r.url,
  }));
}

// ── DuckDuckGo HTML (free, no API key) ─────────────────────────────────────
// Note: lite.duckduckgo.com/lite/ now flags scripted requests as bot traffic
// (returns an anomaly/CAPTCHA challenge). html.duckduckgo.com/html/ with a
// standard browser User-Agent still returns real results.

async function duckduckgoSearch(query: string, maxResults: number): Promise<SearchResult[]> {
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
    body: `q=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`DDG HTTP ${res.status}`);
  const html = await res.text();

  // DuckDuckGo occasionally serves an anti-bot CAPTCHA challenge ("Select all
  // squares containing a duck") instead of real results -- verified this
  // happens under realistic usage (a handful of searches in one session), not
  // just aggressive scraping. Without this check, a blocked request silently
  // parses to zero results, indistinguishable from "the web genuinely has no
  // info about this" -- which is exactly the kind of false signal that leads
  // to confident hallucination instead of TARS honestly saying the search
  // failed. Throw distinctly instead so the caller (and the model) knows the
  // difference.
  if (html.includes('anomaly-modal') || html.includes('anomaly.js')) {
    throw new Error(
      'DuckDuckGo blocked this request as automated traffic (CAPTCHA challenge) -- ' +
      'no results retrieved. Set BRAVE_SEARCH_API_KEY for a more reliable backend.'
    );
  }

  return parseDDGHtml(html, maxResults);
}

function parseDDGHtml(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];

  // Titles are in <a class="result__a" href="...">...</a>
  // Snippets are in <a class="result__snippet" href="...">...</a>
  const titleRe   = /class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  const titles   = [...html.matchAll(titleRe)]  .map(m => ({ url: m[1], title: stripTags(m[2]).trim() }));
  const snippets = [...html.matchAll(snippetRe)].map(m => stripTags(m[1]).trim());

  for (let i = 0; i < Math.min(titles.length, maxResults); i++) {
    if (!titles[i].title || !snippets[i]) continue;
    results.push({ title: titles[i].title, snippet: snippets[i], url: titles[i].url });
  }
  return results;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ');
}

export function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return 'No results found.';
  return results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}${r.url ? `\n${r.url}` : ''}`)
    .join('\n\n');
}
