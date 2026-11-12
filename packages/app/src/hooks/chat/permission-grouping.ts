/**
 * Permission grouping (TER-375).
 *
 * When an agent fires several tools in parallel and they need approval, the
 * backend emits one `tool_permission_request` per tool and the chat renders one
 * `ControlsBar` per card — N stacked widgets, each with its own 60s countdown.
 * The feedback (TER-96/TER-104) is that this is noisy and unclear.
 *
 * Grouping by *parallel batch*: the LLM emits all tools of a step together, so
 * they land as a CONTIGUOUS block of `tool_execution` messages (in toolCallIndex
 * order). Their individual STATUS then diverges — tools with `allow` permission
 * auto-execute (running → completed) while `ask` tools sit in
 * `pending_permission`. So the batch is a contiguous run of tool_execution
 * messages with MIXED statuses; we group the run and frame its pending cards
 * with one header (before the first pending card) and one footer (after the
 * last card of the run) — PERMW-REQ-3.
 *
 * The run breaks only on a NON-tool message (agent text, image, etc.) — a
 * completed/running tool does NOT break it. This is what makes the mix of
 * auto-allowed + ask tools group correctly (the earlier "consecutive pending"
 * heuristic broke the run at every auto-allowed card).
 *
 * No `turnId`/`groupId` from the backend is needed for this. (If the LLM ever
 * interleaves text BETWEEN tools of the same batch — rare — the run would split;
 * propagating a backend group id would be the robust follow-up.)
 *
 * Pure functions — no React, no zustand — unit-tested against a static fixture.
 */

import { parsePermissionMarker } from '../../lib/permission-marker'
import type { Message } from '../../store/chatStore'

/** A single tool awaiting approval inside a grouped run. */
export interface GroupedTool {
  requestId: string
  toolCallId: string
  toolName: string
  appId?: string
  /** Destructive marker. "Allow all" excludes these — they require individual approval. */
  irreversible: boolean
  /** Tool call arguments — drives the row's param digest. Absent for no-arg tools. */
  input?: Record<string, unknown>
  /** Catalog MCA id — lets a per-MCA description override reach the row. */
  mcaId?: string
}

/** A contiguous tool run that holds ≥2 pending tools, framed by header + footer. */
export interface PermissionGroup {
  /**
   * messageId of the LAST tool of the run (newest card of the parallel batch,
   * any status). The footer is anchored below it — visually after the whole
   * batch, even when completed auto-allowed cards trail the pending ones.
   */
  anchorMessageId: string
  /**
   * messageId of the FIRST pending card of the run. The header is rendered
   * right before it (PERMW-REQ-3).
   */
  firstPendingMessageId: string
  /** Only the tools that still need a decision. */
  tools: GroupedTool[]
}

export interface PermissionGroupingResult {
  groups: PermissionGroup[]
  /** anchorMessageId → group (footer goes after it), O(1) while rendering the list. */
  groupByAnchorId: ReadonlyMap<string, PermissionGroup>
  /** firstPendingMessageId → group (header goes before it). */
  groupByFirstPendingId: ReadonlyMap<string, PermissionGroup>
}

/** A lone pending tool shows no header and no footer — only group from 2. */
const MIN_GROUP_SIZE = 2

const EMPTY_RESULT: PermissionGroupingResult = {
  groups: [],
  groupByAnchorId: new Map(),
  groupByFirstPendingId: new Map(),
}

interface PendingContent {
  permissionRequestId: string
  toolCallId: string
  toolName?: string
  appId?: string
  irreversible?: boolean
  input?: Record<string, unknown>
  mcaId?: string
}

function isToolExecution(content: unknown): boolean {
  return (content as { type?: string } | undefined)?.type === 'tool_execution'
}

/**
 * Returns the pending payload if this tool_execution is awaiting approval, else null.
 *
 * Two shapes mean "awaiting the user's decision":
 *   1. status `pending_permission` + `permissionRequestId` (PERMB-REQ-2: what the
 *      backend keeps in the record after the v4 cut).
 *   2. fallback for rows written before PERMB 1.0.0: status `completed` with the
 *      `permission_requested` marker as `output` — the request id, appId and
 *      irreversible flag come from the marker (the content dropped them).
 *
 * A local decision (`resolvePendingLocally`) moves either shape to `running` /
 * `failed`, which this no longer recognises, so the card leaves the batch.
 *
 * @spec PERMB-REQ-4
 */
function asPending(content: unknown): PendingContent | null {
  const c = content as
    | (PendingContent & { type?: string; status?: string; output?: unknown })
    | undefined
  if (c?.type !== 'tool_execution' || typeof c.toolCallId !== 'string') return null
  if (c.status === 'pending_permission' && typeof c.permissionRequestId === 'string') {
    return c
  }
  if (c.status === 'completed' && typeof c.output === 'string') {
    const marker = parsePermissionMarker(c.output)
    if (marker) {
      return {
        ...c,
        permissionRequestId: marker.permissionRequestId,
        appId: c.appId ?? marker.appId,
        irreversible: c.irreversible ?? marker.irreversible,
      }
    }
  }
  return null
}

/**
 * Builds the row's `GroupedTool` from a pending tool_execution payload. Split
 * out of `groupPendingPermissions` so the optional `input`/`mcaId` threading
 * doesn't add to that function's cognitive complexity.
 */
function buildGroupedTool(pending: PendingContent): GroupedTool {
  return {
    requestId: pending.permissionRequestId,
    toolCallId: pending.toolCallId,
    // `||`, not `??`: an empty string is present-but-falsy, and downstream
    // `resolveIntent` (permission-intent.ts) THROWS on a falsy toolName —
    // `??` would let '' sail through and crash the row (and, with no local
    // error boundary, the whole app via RootErrorBoundary) the moment a user
    // expands it. Treat '' the same as null/undefined: both mean "missing."
    toolName: pending.toolName || 'unknown',
    appId: pending.appId,
    irreversible: pending.irreversible === true,
    ...(pending.input ? { input: pending.input } : {}),
    ...(pending.mcaId ? { mcaId: pending.mcaId } : {}),
  }
}

/**
 * Group the pending tools of each contiguous tool-execution run.
 *
 * @spec PERMB-REQ-4
 * @spec PERMW-REQ-3
 *
 * `messageIds` MUST be in chronological order (oldest → newest): the raw
 * `channelMessages[channelId]` array, NOT the inverted FlatList array.
 */
export function groupPendingPermissions(
  messageIds: ReadonlyArray<string>,
  messagesById: Record<string, Message>,
): PermissionGroupingResult {
  if (messageIds.length === 0) return EMPTY_RESULT

  const groups: PermissionGroup[] = []
  let runPending: GroupedTool[] = []
  let runLastToolMessageId: string | undefined
  let runFirstPendingMessageId: string | undefined

  const flush = () => {
    if (runPending.length >= MIN_GROUP_SIZE && runLastToolMessageId && runFirstPendingMessageId) {
      groups.push({
        anchorMessageId: runLastToolMessageId,
        firstPendingMessageId: runFirstPendingMessageId,
        tools: runPending,
      })
    }
    runPending = []
    runLastToolMessageId = undefined
    runFirstPendingMessageId = undefined
  }

  for (const msgId of messageIds) {
    const content = messagesById[msgId]?.content
    if (isToolExecution(content)) {
      // Part of the current batch run — a completed/running tool keeps it alive.
      runLastToolMessageId = msgId
      const pending = asPending(content)
      if (pending) {
        runFirstPendingMessageId ??= msgId
        runPending.push(buildGroupedTool(pending))
      }
    } else {
      // Agent text / image / etc. ends the batch run.
      flush()
    }
  }
  flush()

  if (groups.length === 0) return EMPTY_RESULT

  const groupByAnchorId = new Map<string, PermissionGroup>()
  const groupByFirstPendingId = new Map<string, PermissionGroup>()
  for (const g of groups) {
    groupByAnchorId.set(g.anchorMessageId, g)
    groupByFirstPendingId.set(g.firstPendingMessageId, g)
  }
  return { groups, groupByAnchorId, groupByFirstPendingId }
}

/**
 * requestIds to grant on "Allow all" — REVERSIBLE tools only. Irreversible
 * (destructive) tools are excluded by design (TER-375): they stay pending and
 * require individual approval. Pure so the decision is unit-tested.
 */
export function requestIdsForAllowAll(
  tools: ReadonlyArray<{ requestId: string; irreversible: boolean }>,
): string[] {
  return tools.filter((tool) => !tool.irreversible).map((tool) => tool.requestId)
}

/** requestIds to deny on "Deny all" — every tool in the group (denying is safe). */
export function requestIdsForDenyAll(
  tools: ReadonlyArray<{ requestId: string }>,
): string[] {
  return tools.map((tool) => tool.requestId)
}

/**
 * Value-sensitive tag for one pending row's `input`.
 *
 * `JSON.stringify` throws on a circular structure and silently drops functions
 * and `undefined`; tool arguments arrive as parsed JSON so neither should occur,
 * but a signature helper must not be the thing that takes down the chat, and a
 * throw here would be indistinguishable from a render bug. Falling back to the
 * key count keeps grouping working — the digest may lag on that one degenerate
 * payload, which is strictly better than a blank conversation.
 */
function inputTag(input: Record<string, unknown> | undefined): string {
  if (!input) return '0'
  try {
    return JSON.stringify(input) ?? '0'
  } catch {
    return String(Object.keys(input).length)
  }
}

/**
 * Cheap, stable string signature of the grouping-relevant state. Used as the
 * reactive zustand selector value in `usePermissionGroups`: a primitive string
 * stays referentially stable (Object.is) on unrelated message updates, so the
 * expensive `groupPendingPermissions` only re-runs when the result could differ.
 *
 * @spec PERMB-REQ-4
 *
 * Encodes every tool_execution (id + status + pending fields) and a break marker
 * (`/`) for each non-tool message, so a batch split by agent text produces a
 * different signature than a contiguous one.
 */
export function computeGroupingSignature(
  messageIds: ReadonlyArray<string>,
  messagesById: Record<string, Message>,
): string {
  const parts: string[] = []
  let sawTool = false
  for (const msgId of messageIds) {
    const content = messagesById[msgId]?.content
    if (isToolExecution(content)) {
      sawTool = true
      const c = content as PendingContent & { status?: string }
      // The tag must cover every field a row RENDERS, not just the ones that
      // decide grouping: `toolName`/`appId` key the tool-details lookup and
      // `input` drives the digest, the intent override and the expanded params.
      // If one of those arrives via a later `upsertToolMessage` merge without
      // status or requestId changing, an unchanged signature would leave
      // usePermissionGroups' memo cold and the panel showing stale rows.
      //
      // `input` is covered by VALUE, not by key count. An arity-only tag missed
      // an in-place correction that keeps the key set ({path:"src/a"} →
      // {path:"src/abc"}), which is exactly the change a reviewer comparing
      // sibling rows reads off the digest. Only computed for pending rows, so the
      // stringify is bounded by the size of one approval batch.
      //
      // Read through `asPending` so a `completed` card carrying the v4 marker
      // (PERMB-REQ-4 fallback) is tagged as pending too: its request id comes
      // from the output, and the moment it lands the panel must appear.
      const pending = asPending(content)
      const pendingTag = pending
        ? [
            pending.permissionRequestId,
            pending.irreversible ? '!' : '',
            pending.toolName ?? '',
            pending.appId ?? '',
            pending.mcaId ?? '',
            inputTag(pending.input),
          ].join(',')
        : ''
      parts.push(`${msgId}:${c.status ?? ''}:${pendingTag}`)
    } else if (parts.length > 0 && parts[parts.length - 1] !== '/') {
      parts.push('/')
    }
  }
  return sawTool ? parts.join('|') : ''
}
