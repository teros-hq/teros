import type { ToolConfig } from '@teros/mca-sdk';
import { GUIDE_TOPICS } from '../content/topics';

/**
 * Lexical (keyword) search over the guide — the "Search" of the canonical
 * Search/Find/Open retrieval pattern. NO embeddings: the corpus is small (13
 * topics) and stable, where lexical ranking suffices and wins on exact-match
 * technical queries (see TER-583 analysis). When the guide grows past Phase-2
 * scale, this same tool surface can switch to semantic ranking WITHOUT changing
 * the contract.
 *
 * Deterministic + testable: weighted field match (title > id > keywords >
 * summary > body), stable tiebreak by GUIDE_TOPICS order.
 */

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 13;

// Field weights — a token hit in the title matters far more than one in the body.
const W_TITLE = 10;
const W_ID = 8;
const W_KEYWORD = 6;
const W_SUMMARY = 3;
const W_BODY = 1;

export interface GuideSearchResult {
  id: string;
  title: string;
  summary: string;
  score: number;
  /** Short excerpt of the body around the first query hit (or the summary). */
  snippet: string;
}
export interface SearchGuideOutput {
  query: string;
  results: GuideSearchResult[];
  count: number;
}

/** Tokenize a query into lowercased alphanumeric terms of length >= 2. */
function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

function snippetFor(body: string, tokens: string[], summary: string): string {
  const lower = body.toLowerCase();
  let pos = -1;
  for (const t of tokens) {
    const i = lower.indexOf(t);
    if (i !== -1 && (pos === -1 || i < pos)) pos = i;
  }
  if (pos === -1) return summary;
  const start = Math.max(0, pos - 40);
  const end = Math.min(body.length, pos + 120);
  const raw = body.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${raw}${end < body.length ? '…' : ''}`;
}

export const searchGuide: ToolConfig<{ query?: string; limit?: number }, unknown> = {
  description:
    'Search the Teros platform guide by free-text query and get the most relevant section(s) with a snippet — the fastest way to answer how-to questions about Teros. Teros specifics are NOT in your training data; search here instead of guessing. Returns {query, results:[{id,title,summary,score,snippet}], count}. Use get-guide-section for a result\'s full body.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Free-text query, e.g. "how do I create an agent" or "connect gmail".',
      },
      limit: {
        type: 'number',
        description: `Max results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
      },
    },
    required: ['query'],
  },
  annotations: {
    version: '1.0.0',
    stability: 'stable',
    readOnlyHint: true,
    idempotentHint: true,
  },
  // Returns plain data (the MCA runtime serializes it as the agent-visible
  // output; no {content, structuredContent} wrapper — see list-topics.ts).
  handler: async (args): Promise<SearchGuideOutput> => {
    const query = String(args?.query ?? '').trim();
    if (!query) throw new Error('query is required and must be non-empty');
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(args?.limit ?? DEFAULT_LIMIT))));
    const tokens = tokenize(query);

    const scored = GUIDE_TOPICS.map((t) => {
      const title = t.title.toLowerCase();
      const id = t.id.toLowerCase();
      const keywords = t.keywords.join(' ').toLowerCase();
      const summary = t.summary.toLowerCase();
      const body = t.body.toLowerCase();
      let score = 0;
      for (const tok of tokens) {
        if (title.includes(tok)) score += W_TITLE;
        if (id.includes(tok)) score += W_ID;
        if (keywords.includes(tok)) score += W_KEYWORD;
        if (summary.includes(tok)) score += W_SUMMARY;
        if (body.includes(tok)) score += W_BODY;
      }
      return { topic: t, score };
    });

    // score desc; stable tiebreak by original GUIDE_TOPICS order (preserved by
    // a stable sort since `scored` is in topic order).
    const results: GuideSearchResult[] = scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => ({
        id: s.topic.id,
        title: s.topic.title,
        summary: s.topic.summary,
        score: s.score,
        snippet: snippetFor(s.topic.body, tokens, s.topic.summary),
      }));

    return { query, results, count: results.length };
  },
};
