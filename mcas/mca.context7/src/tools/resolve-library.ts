import type { ToolConfig } from '@teros/mca-sdk';
import { fetchContext7Json } from '../lib/client';
import { TtlCache } from '../lib/cache';
import { type LibraryCandidate, parseLibraryCandidates } from '../lib/parser';

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const cache = new TtlCache<LibraryCandidate[]>(CACHE_TTL_MS);

function cacheKey(libraryName: string, query: string): string {
  return `${libraryName.toLowerCase().trim()}|${query.toLowerCase().trim()}`;
}

export interface ResolveLibraryOutput {
  libraryName: string;
  query: string;
  candidates: LibraryCandidate[];
  cached: boolean;
  resolvedFrom: 'user' | 'anonymous';
}

export const resolveLibrary: ToolConfig<{ libraryName: string; query?: string }, unknown> = {
  description:
    'Resolve a Context7 library identifier from a free-text name (e.g. "react" → "/reactjs/react.dev"). Returns ranked candidates with reputation and snippet count. Cache: 7d. Use the chosen `id` as `libraryId` for `get-docs`.',
  parameters: {
    type: 'object',
    properties: {
      libraryName: { type: 'string', description: 'Library name to resolve (e.g. "react", "tamagui")' },
      query: { type: 'string', description: 'Optional refinement query (e.g. "hooks", "router")' },
    },
    required: ['libraryName'],
  },
  annotations: {
    version: '1.0.0',
    stability: 'stable',
    readOnlyHint: true,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    const libraryName = String(args.libraryName ?? '').trim();
    const query = String(args.query ?? '').trim();
    if (!libraryName) throw new Error('libraryName is required');

    let userSecrets: Record<string, string> | null = null;
    try {
      userSecrets = await context.getUserSecrets();
    } catch {
      userSecrets = null;
    }
    const apiKey = userSecrets?.CONTEXT7_API_KEY ?? userSecrets?.context7_api_key;
    const resolvedFrom: 'user' | 'anonymous' = apiKey ? 'user' : 'anonymous';

    const key = cacheKey(libraryName, query);
    const cached = cache.get(key);
    if (cached) {
      const out: ResolveLibraryOutput = {
        libraryName,
        query,
        candidates: cached,
        cached: true,
        resolvedFrom,
      };
      return wrap(out);
    }

    const raw = await fetchContext7Json<unknown>('/v2/libs/search', {
      apiKey,
      searchParams: query ? { libraryName, query } : { libraryName },
    });
    const candidates = parseLibraryCandidates(raw).sort((a, b) => b.benchmarkScore - a.benchmarkScore);
    cache.set(key, candidates);

    const out: ResolveLibraryOutput = {
      libraryName,
      query,
      candidates,
      cached: false,
      resolvedFrom,
    };
    return wrap(out);
  },
};

function wrap<T>(data: T) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

export const __testing = { cache, cacheKey };
