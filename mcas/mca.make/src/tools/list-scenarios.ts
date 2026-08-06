import type { ToolConfig } from '@teros/mca-sdk';
import { accountApiJson, normalizeRegion } from '../lib/make-client';
import { clampLimit, clampOffset, getUserSecretsSafe, requireApiToken } from './_helpers';

const VERSION = '1.0.0';

interface RawScenario {
  id?: number | string;
  name?: string;
  isActive?: boolean;
  isPaused?: boolean;
  teamId?: number | string;
  description?: string;
  folderId?: number | string | null;
}

/** Pagination block echoed by the Make API (`pg`). `total`/`totalCount` is plan-dependent. */
interface RawPg {
  limit?: number;
  offset?: number;
  total?: number;
  totalCount?: number;
}

interface RawListResponse {
  scenarios?: RawScenario[];
  pg?: RawPg;
}

export interface ScenarioItem {
  id: string;
  name: string;
  isActive: boolean | null;
  isPaused: boolean | null;
  teamId: string | null;
  description?: string;
  folderId?: string;
}

export interface ListScenariosResult {
  scenarios: ScenarioItem[];
  /** Count returned on this page. */
  returned: number;
  /** Real upstream total when the account/endpoint reports one, else `offset + returned` (a lower bound). */
  total: number;
  offset: number;
  limit: number;
  /** True when another page is available (precise when the upstream reports a total, else a full-page heuristic). */
  hasMore: boolean;
  /** Offset to pass on the next call to continue paging, or null when there is no more. */
  nextOffset: number | null;
  teamId: string | null;
  region: string;
  /** Raw upstream rows — only present when `includeRaw: true` was requested (debug). */
  raw?: RawScenario[];
}

/** Whitelist + normalize the fields the renderer needs — never echo the raw row. */
function pickScenario(s: RawScenario): ScenarioItem {
  const item: ScenarioItem = {
    id: s.id != null ? String(s.id) : '',
    name: s.name ?? '(unnamed scenario)',
    isActive: typeof s.isActive === 'boolean' ? s.isActive : null,
    isPaused: typeof s.isPaused === 'boolean' ? s.isPaused : null,
    teamId: s.teamId != null ? String(s.teamId) : null,
  };
  if (s.description) item.description = s.description;
  if (s.folderId != null) item.folderId = String(s.folderId);
  return item;
}

/** Real upstream total if the `pg` block carried one, else null (plan-dependent). */
function upstreamTotal(pg: RawPg | undefined): number | null {
  if (typeof pg?.total === 'number') return pg.total;
  if (typeof pg?.totalCount === 'number') return pg.totalCount;
  return null;
}

/**
 * list-scenarios — list the account's Make scenarios (requires MAKE_API_TOKEN).
 * Paginated via `limit` + `offset` (mapped to the Make `pg[limit]`/`pg[offset]`
 * query params). `teamId` is optional here but required by the Make API on most
 * accounts; if absent the upstream 400/error message surfaces verbatim
 * (prefixed with the mapped `[CODE]`).
 */
export const listScenariosTool: ToolConfig<
  { teamId?: string; limit?: number; offset?: number; includeRaw?: boolean },
  unknown
> = {
  description:
    'List Make.com scenarios for the configured account (requires MAKE_API_TOKEN in user secrets). Optionally filter by teamId and page with limit/offset. Returns { scenarios: [{ id, name, isActive, isPaused, teamId }], returned, total, offset, limit, hasMore, nextOffset, teamId, region }. When hasMore is true, call again with offset=nextOffset to fetch the next page.',
  parameters: {
    type: 'object',
    properties: {
      teamId: {
        type: 'string',
        description:
          'Make team id to scope the scenarios (found in the team URL). Required by the Make API on most accounts.',
      },
      limit: {
        type: 'number',
        description: 'Max scenarios to return per page (1-100, default 50).',
      },
      offset: {
        type: 'number',
        description:
          'Number of scenarios to skip for pagination (default 0). Pass the `nextOffset` from a previous response to fetch the next page.',
      },
      includeRaw: {
        type: 'boolean',
        description:
          'Include the unprocessed upstream scenario rows under `raw` for debugging (default false).',
      },
    },
  },
  annotations: {
    version: VERSION,
    stability: 'stable',
    readOnlyHint: true,
    openWorldHint: true,
  },
  handler: async (args, context): Promise<ListScenariosResult> => {
    const secrets = await getUserSecretsSafe(context);
    const apiKey = requireApiToken(secrets);
    const region = normalizeRegion(secrets.MAKE_REGION);

    const teamId = args.teamId != null ? String(args.teamId).trim() : '';
    const limit = clampLimit(args.limit);
    const offset = clampOffset(args.offset);
    const includeRaw = args.includeRaw === true;

    const searchParams: Record<string, string> = { 'pg[limit]': String(limit) };
    if (offset > 0) searchParams['pg[offset]'] = String(offset);
    if (teamId) searchParams.teamId = teamId;

    const data = await accountApiJson<RawListResponse>('GET', '/scenarios', {
      apiKey,
      region,
      searchParams,
      signal: context.signal,
    });

    const rawScenarios = data.scenarios ?? [];
    const scenarios = rawScenarios.map(pickScenario);
    const returned = scenarios.length;

    // Make's /scenarios endpoint does not reliably report a total count, so use
    // the real total when present and otherwise infer "more pages" from a full
    // page. `total` is a true lower bound when the upstream total is unknown.
    const total = upstreamTotal(data.pg);
    const hasMore = total != null ? offset + returned < total : returned >= limit;
    const nextOffset = hasMore ? offset + returned : null;

    const result: ListScenariosResult = {
      scenarios,
      returned,
      total: total ?? offset + returned,
      offset,
      limit,
      hasMore,
      nextOffset,
      teamId: teamId || null,
      region,
    };
    if (includeRaw) result.raw = rawScenarios;
    return result;
  },
};
