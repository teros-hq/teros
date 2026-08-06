/**
 * mca.teros.guide — Tool Call Renderer
 *
 * 100% coverage: every tool the Teros Guide MCA exposes has a dedicated
 * sub-renderer composing GLOBAL primitives only (Renderer UX Guide v2/v2.1,
 * TER-281 zero-local-components). Brand identity comes from the bundled logo
 * via `iconUri` (appIcon) — no local styling needed.
 *
 * Tools covered:
 *   - list-guide-topics → EntityRow per topic (title + one-line summary)
 *   - search-guide      → EntityRow per result (title + snippet)
 *   - get-guide-section → ResourceCard + MarkdownContent (the section body)
 *   - -health-check     → collapsed header with a health badge
 *
 * Monolithic (single file) on purpose: 3 tools + health-check, high cohesion
 * (criterion: reuse global primitives, not the structural pattern).
 */

import type React from 'react';

import { MarkdownContent } from '../../chat/bubbles/MarkdownContent';
import {
  Badge,
  countBadgeVariant,
  Empty,
  EntityRow,
  ErrorBlock,
  formatCountBadge,
  getShortToolName,
  MAX_ITEMS,
  parseOutput,
  ResourceCard,
  tenseByStatus,
  ToolCallCard,
} from '../primitives';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';

const GUIDE_MCA_ID = 'mca.teros.guide';

// ────────────────────────────────────────────────────────────────────────────
// Data shapes (mirror the backend tool outputs)
// ────────────────────────────────────────────────────────────────────────────

interface GuideTopicIndexEntry {
  id: string;
  title: string;
  summary: string;
}
interface ListGuideTopicsOutput {
  topics: GuideTopicIndexEntry[];
  count: number;
}
interface GetGuideSectionOutput {
  id: string;
  title: string;
  summary: string;
  body: string;
  related: string[];
}
interface GuideSearchResult {
  id: string;
  title: string;
  summary: string;
  score: number;
  snippet: string;
}
interface SearchGuideOutput {
  query: string;
  results: GuideSearchResult[];
  count: number;
}
type HealthStatus = 'ready' | 'not_ready' | 'degraded';
interface HealthCheckResult {
  status: HealthStatus;
  issues?: Array<{ code: string; message: string }>;
  version?: string;
}

/**
 * Unwrap the MCP tool result `{ content, structuredContent }`. The backend
 * serializes it; `parseOutput` does the JSON parse, then we lift
 * `structuredContent` (data helper, not a component — TER-281 compliant).
 */
function unwrap<T>(output?: string): T | null {
  if (!output) return null;
  const parsed = parseOutput<{ structuredContent?: T } | T>(output);
  if (parsed && typeof parsed === 'object' && 'structuredContent' in parsed) {
    return (parsed as { structuredContent: T }).structuredContent;
  }
  return (parsed as T) ?? null;
}

// ────────────────────────────────────────────────────────────────────────────
// SUB-RENDERER: list-guide-topics (Pattern A — read list)
// ────────────────────────────────────────────────────────────────────────────

function ListGuideTopicsRenderer(props: ToolCallRendererProps): React.ReactNode {
  const { status, output, appIcon } = props;
  const data = unwrap<ListGuideTopicsOutput>(output);
  const topics = data?.topics ?? [];
  const count = data?.count ?? topics.length;

  const description = tenseByStatus(status, {
    future: 'list the Teros guide topics',
    present: 'Reading the guide index',
    past: `Listed ${count} guide topics`,
  });

  const badge =
    status === 'completed' && count > 0 ? (
      <Badge text={formatCountBadge(count, 'topic')} variant={countBadgeVariant(count)} />
    ) : null;

  return (
    <ToolCallCard status={status} description={description} iconUri={appIcon} badge={badge}>
      {status === 'completed' && count === 0 && <Empty message="No guide topics available" />}
      {status === 'completed' &&
        topics
          .slice(0, MAX_ITEMS)
          .map((topic) => (
            <EntityRow key={topic.id} title={topic.title} subtitle={topic.summary} />
          ))}
    </ToolCallCard>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// SUB-RENDERER: search-guide (Pattern A — search results)
// ────────────────────────────────────────────────────────────────────────────

function SearchGuideRenderer(props: ToolCallRendererProps): React.ReactNode {
  const { status, output, input, appIcon } = props;
  const data = unwrap<SearchGuideOutput>(output);
  const query = (input?.query as string) || data?.query || '';
  const results = data?.results ?? [];
  const count = data?.count ?? results.length;
  const shortQuery = query.length > 48 ? `${query.slice(0, 48)}…` : query;

  const description = tenseByStatus(status, {
    future: `search the guide for "${shortQuery}"`,
    present: 'Searching the guide',
    past: `Guide search: "${shortQuery}"`,
  });

  const badge =
    status === 'completed' && count > 0 ? (
      <Badge text={formatCountBadge(count, 'result')} variant={countBadgeVariant(count)} />
    ) : null;

  return (
    <ToolCallCard status={status} description={description} iconUri={appIcon} badge={badge}>
      {status === 'completed' && count === 0 && (
        <Empty message="No matching guide sections" hint="Try different words, or list-guide-topics" />
      )}
      {status === 'completed' &&
        results
          .slice(0, MAX_ITEMS)
          .map((r) => <EntityRow key={r.id} title={r.title} subtitle={r.snippet} />)}
    </ToolCallCard>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// SUB-RENDERER: get-guide-section (Pattern B — get / detail)
// ────────────────────────────────────────────────────────────────────────────

function GetGuideSectionRenderer(props: ToolCallRendererProps): React.ReactNode {
  const { status, output, error, input, appIcon } = props;
  const data = unwrap<GetGuideSectionOutput>(output);
  const requestedTopic = (input?.topic as string) || data?.id || '';
  const title = data?.title || requestedTopic;

  const description = tenseByStatus(status, {
    future: `open the guide section: ${requestedTopic}`,
    present: 'Reading the guide',
    past: `Guide: ${title}`,
  });

  return (
    <ToolCallCard status={status} description={description} iconUri={appIcon}>
      {status === 'failed' && <ErrorBlock error={error || 'Failed to load guide section'} />}
      {status === 'completed' && data && (
        <ResourceCard title={data.title} subtitle={data.summary}>
          <MarkdownContent text={data.body} />
        </ResourceCard>
      )}
    </ToolCallCard>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// SUB-RENDERER: -health-check (Pattern E — internal, header + health badge)
// ────────────────────────────────────────────────────────────────────────────

function HealthCheckRenderer(props: ToolCallRendererProps): React.ReactNode {
  const { status, output, appIcon } = props;
  const result = unwrap<HealthCheckResult>(output);
  const healthy = result?.status === 'ready' && (result?.issues?.length ?? 0) === 0;

  const badge =
    status === 'completed' ? (
      <Badge text={healthy ? 'healthy' : 'degraded'} variant={healthy ? 'success' : 'gray'} />
    ) : null;

  return (
    <ToolCallCard
      status={status}
      description="Health check"
      iconUri={appIcon}
      badge={badge}
      defaultExpanded={false}
    />
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Dispatcher (100% coverage — no fallback; a missing tool is a bug)
// ────────────────────────────────────────────────────────────────────────────

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  'list-guide-topics': ListGuideTopicsRenderer,
  'search-guide': SearchGuideRenderer,
  'get-guide-section': GetGuideSectionRenderer,
  '-health-check': HealthCheckRenderer,
};

function GuideRendererBase(props: ToolCallRendererProps): React.ReactNode {
  const shortName = getShortToolName(props.toolName);
  const Renderer = RENDERERS[shortName];
  if (!Renderer) {
    if (typeof console !== 'undefined') {
      console.warn(`[GuideRenderer] No dedicated renderer for tool: ${props.toolName}`);
    }
    return null;
  }
  return <Renderer {...props} />;
}

export const GuideToolCallRenderer = withPermissionSupport(GuideRendererBase);
export default GuideToolCallRenderer;
