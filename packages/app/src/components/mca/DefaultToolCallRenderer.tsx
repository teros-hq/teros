/**
 * Default Tool Call Renderer — Fallback Body for MCAs without a custom
 * renderer (Renderer UX Guide v2 §0).
 *
 * Before v2 this file pinned the chat with a JSON-crud view and emitted
 * a Sentry "missing renderer" warning. v2 reframes the absence: a
 * Fallback Body is now legitimate UI. We still emit a low-noise Sentry
 * tag (`type=no_custom_renderer`) so coverage can be tracked, but the
 * tool call is fully presentable on its own.
 *
 * The renderer composes the same primitives every custom renderer uses:
 *   <ToolCallCard description="…">
 *     <FallbackBody status input output error />
 *   </ToolCallCard>
 *
 * Permission flow (`pending_permission`) keeps the existing widget for
 * now; Fase 4 of the v2 refactor swaps it for a single-line ControlsBar
 * primitive.
 */

import { useMemo } from 'react';
import { useToolDetails } from '../../hooks/mca/useToolDetails';
import { FallbackBody, getShortToolName, ToolCallCard } from './primitives';
import { usePermissionControls } from './primitives/PermissionControlsContext';
import { humanizeLabel } from './primitives/utils';
import type { ToolCallRendererProps } from './types';
import { withPermissionSupport } from './withPermissionSupport';

/**
 * PERMW-REQ-4: while the tool waits for a decision, the header says what the
 * tool does in words — the tool's humanized description from the tool details
 * — and names the app ("HubSpot · Create a new HubSpot contact"). Before the
 * details load (or when they never do) it reads the humanized tool name, as
 * before. The details are only fetched while a permission is pending (the
 * permission context is set), the same lookup PermissionDetail makes.
 *
 * @spec PERMW-REQ-4
 */
function DefaultToolCallRendererBase(props: ToolCallRendererProps) {
  const { toolName, input, status, output, error, appIcon, attachments } = props;

  const permission = usePermissionControls();
  const detailNames = useMemo(() => [toolName], [toolName]);
  const { details, appName } = useToolDetails(permission ? permission.appId : undefined, detailNames);
  const detailDescription = details[toolName]?.description?.trim();

  // Static description: the tool's own words when known, else the humanized
  // tool name. No tense conjugation.
  const description = detailDescription || humanizeLabel(getShortToolName(toolName));

  return (
    <ToolCallCard
      status={status}
      description={description}
      appName={appName}
      iconUri={appIcon}
      animateExpand
    >
      <FallbackBody status={status} input={input} output={output} error={error} attachments={attachments} />
    </ToolCallCard>
  );
}

// withPermissionSupport handles pending_permission: it renders the ControlsBar as
// a sibling below the card, and hands the approval detail down through
// PermissionControlsContext so ToolCallCard appends it to the body. FallbackBody
// contributes nothing while pending (its ParamsTable is suppressed, because the
// detail's AnnotatedParamsTable shows the same input with more), so the approval
// detail is the whole body for a default-rendered tool. No bespoke wiring here.
/** @spec PERMW-REQ-4 */
export const DefaultToolCallRenderer = withPermissionSupport(DefaultToolCallRendererBase);

