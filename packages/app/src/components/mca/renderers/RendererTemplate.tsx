/**
 * Canonical MCA Renderer Template — START HERE for new MCAs and for
 * migration of existing ones to the Renderer UX Guide v2/v2.1.
 *
 * This file is NOT registered in `index.ts`. It's a starter that
 * documents the canonical patterns by example:
 *
 *   - Uses `ToolCallCard` as the container (guide §1).
 *   - Maps each tool to one of the 5 layout patterns §6 A-E.
 *   - Reads `irreversible` from props (manifest static) and `risk` from
 *     `permission-heuristics.ts` (per-call, only for polymorphic tools).
 *   - Composes the body using ONLY primitives from `../primitives`.
 *   - Never imports `ControlsBar` directly — the card mounts it on
 *     `pending_permission` via the HOC-injected context.
 *
 * To create a new renderer:
 *   1. Copy this file to `<MyMca>Renderer.tsx`.
 *   2. Replace `MY_MCA_ID` with your MCA id.
 *   3. Implement one renderer per tool, mapped in `RENDERERS`.
 *   4. Each tool renderer chooses a pattern A-E and uses its primitives.
 *   5. Wrap the dispatcher in `withPermissionSupport`.
 *   6. Register the renderer in `renderers/index.ts`.
 *   7. Add the renderer path to `MIGRATED` in
 *      `tests/unit/components/mca/toolCallCardAdoption.test.tsx`.
 */

import type React from 'react';

import {
  ActionBadge,
  Badge,
  countBadgeVariant,
  Empty,
  EntityRow,
  ErrorBlock,
  formatCountBadge,
  KeyValueGrid,
  MAX_ITEMS,
  parseOutput,
  ResourceCard,
  SuccessBlock,
  ToolCallCard,
  tenseByStatus,
  getShortToolName,
} from '../primitives';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';
import { isToolCallElevatedRisk, isToolCallIrreversible } from './permission-heuristics';

const MY_MCA_ID = 'mca.example.template';

// ============================================================================
// Pattern A — Read list (guide §6 A)
// ============================================================================
//
// Tool example: list-items
// - Header: status dot, app icon, "Listed N items" tense, count badge.
// - Body: scroll of EntityRow per item (cap at MAX_ITEMS).
// - Empty state: <Empty> primitive when count === 0.
//
function ListItemsRenderer(props: ToolCallRendererProps) {
  const { status, output, appIcon } = props;

  const parsed = output ? parseOutput<{ items?: Array<{ id: string; name: string }> }>(output) : null;
  const items = typeof parsed === 'object' && parsed?.items ? parsed.items : [];
  const count = items.length;

  // Description with correct tense (guide §2 slot 3).
  // `tenseByStatus(status, forms)` builds the right tense:
  //   pending             → "Will list 3 items"
  //   running             → "Listing items…"
  //   completed           → "Listed 3 items"
  //   failed              → "Failed to list items"
  //   pending_permission  → "Wants to list items"
  const description = tenseByStatus(status, {
    future: 'list items',
    present: 'Listing items',
    past: `Listed ${count} items`,
  });

  const badge =
    status === 'completed' ? (
      <Badge text={formatCountBadge(count, 'item')} variant={countBadgeVariant(count)} />
    ) : null;

  return (
    <ToolCallCard
      status={status}
      description={description}
      iconUri={appIcon}
      badge={badge}
    >
      {status === 'completed' && count === 0 && (
        <Empty message="No items yet" hint="Try a different filter" />
      )}
      {status === 'completed' &&
        count > 0 &&
        items.slice(0, MAX_ITEMS).map((item) => (
          <EntityRow key={item.id} title={item.name} subtitle={item.id} />
        ))}
    </ToolCallCard>
  );
}

// ============================================================================
// Pattern B — Get / detail (guide §6 B)
// ============================================================================
//
// Tool example: get-item
// - Body: ResourceCard + KeyValueGrid (or MetaStrip / Specsheet for richer
//   layouts).
// - No badge in the header — the body carries the detail.
//
function GetItemRenderer(props: ToolCallRendererProps) {
  const { status, output, appIcon } = props;

  const parsed = output ? parseOutput<{ name: string; createdAt: string; size: number }>(output) : null;
  const item = typeof parsed === 'object' ? parsed : null;

  const description = tenseByStatus(status, {
    future: 'retrieve item',
    present: 'Retrieving item',
    past: 'Retrieved item',
  });

  return (
    <ToolCallCard status={status} description={description} iconUri={appIcon}>
      {status === 'completed' && item && (
        <ResourceCard title={item.name} subtitle={item.createdAt}>
          <KeyValueGrid
            rows={[
              { key: 'Created', value: item.createdAt },
              { key: 'Size', value: `${item.size} bytes` },
            ]}
          />
        </ResourceCard>
      )}
      {status === 'failed' && <ErrorBlock error="Failed to retrieve item" />}
    </ToolCallCard>
  );
}

// ============================================================================
// Pattern C — Mutation (guide §6 C)
// ============================================================================
//
// Tool example: delete-item — irreversible mutation.
// - Header: ActionBadge with verb in the badge slot.
// - `irreversible` flows from manifest → props (or from
//   isToolCallIrreversible for polymorphic tools).
// - `risk` is computed via isToolCallElevatedRisk if the tool can be
//   risky based on input — usually only bash/exec-like tools.
// - Body: SuccessBlock on completed, ErrorBlock on failed.
//
function DeleteItemRenderer(props: ToolCallRendererProps) {
  const { status, output, error, irreversible, appIcon, toolName, input, mcaId } = props;

  const description =
    status === 'pending_permission'
      ? 'Wants to delete item'
      : status === 'running'
        ? 'Deleting item'
        : status === 'completed'
          ? 'Deleted item'
          : 'Failed to delete item';

  const badge =
    status === 'completed' ? <ActionBadge verb="deleted" /> : null;

  // Per-call risk decision — only fires for polymorphic tools whose
  // registry has an entry. For static tools this returns false and
  // the indicator is not shown.
  const risk = isToolCallElevatedRisk(
    mcaId ?? MY_MCA_ID,
    getShortToolName(toolName),
    input,
  );

  // For polymorphic tools the manifest no longer carries
  // `irreversible: true` — derive it from the registry. For static
  // tools just trust the prop from upstream.
  const effectiveIrreversible =
    irreversible ||
    isToolCallIrreversible(mcaId ?? MY_MCA_ID, getShortToolName(toolName), input);

  return (
    <ToolCallCard
      status={status}
      description={description}
      iconUri={appIcon}
      badge={badge}
      irreversible={effectiveIrreversible}
      risk={risk}
    >
      {status === 'completed' && <SuccessBlock message={output || 'Item deleted'} />}
      {status === 'failed' && <ErrorBlock error={error || 'Delete failed'} />}
    </ToolCallCard>
  );
}

// ============================================================================
// Pattern E — Health check (guide §6 E)
// ============================================================================
//
// Tool example: -health-check
// - Header only, no body.
// - Badge encodes the health state.
//
function HealthCheckRenderer(props: ToolCallRendererProps) {
  const { status, appIcon } = props;
  const description = status === 'completed' ? 'Connected' : 'Health check failed';
  const badge =
    status === 'completed' ? <Badge text="connected" variant="success" /> : null;

  return <ToolCallCard status={status} description={description} iconUri={appIcon} badge={badge} />;
}

// ============================================================================
// Dispatcher
// ============================================================================

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  'list-items': ListItemsRenderer,
  'get-item': GetItemRenderer,
  'delete-item': DeleteItemRenderer,
  '-health-check': HealthCheckRenderer,
};

function TemplateRendererBase(props: ToolCallRendererProps) {
  const shortName = getShortToolName(props.toolName);
  const Renderer = RENDERERS[shortName];

  // No fallback — if a tool is missing, the McaRegistry falls back to
  // `DefaultToolCallRenderer` which is a clean `ToolCallCard` with
  // `FallbackBody`. The renderer that owns the MCA is responsible for
  // covering every tool the MCA exposes.
  if (!Renderer) return null;
  return <Renderer {...props} />;
}

export const TemplateToolCallRenderer = withPermissionSupport(TemplateRendererBase);

export default TemplateToolCallRenderer;
