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
 * messages with MIXED statuses; we group the run and surface the pending ones
 * under a single panel.
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

import type { Message } from '../../store/chatStore'

/** A single tool awaiting approval inside a grouped panel. */
export interface GroupedTool {
  requestId: string
  toolCallId: string
  toolName: string
  appId?: string
  /** Destructive marker. "Allow all" excludes these — they require individual approval. */
  irreversible: boolean
}

/** A contiguous tool run that holds ≥2 pending tools rendered under one panel. */
export interface PermissionGroup {
  /**
   * messageId of the LAST tool of the run (newest card of the parallel batch,
   * any status). The panel is anchored below it — visually after the whole
   * batch, even when completed auto-allowed cards trail the pending ones.
   */
  anchorMessageId: string
  /** Only the tools that still need a decision. */
  tools: GroupedTool[]
}

export interface PermissionGroupingResult {
  groups: PermissionGroup[]
  /**
   * requestIds of pending tools that belong to a group (≥2 pending in a run).
   * `withPermissionSupport` reads this set to suppress the per-card ControlsBar —
   * the panel owns the flow instead.
   */
  groupedRequestIds: ReadonlySet<string>
  /** anchorMessageId → group, for O(1) lookup while rendering the list. */
  groupByAnchorId: ReadonlyMap<string, PermissionGroup>
}

/** A lone pending tool keeps the per-card ControlsBar — only group from 2. */
const MIN_GROUP_SIZE = 2

const EMPTY_RESULT: PermissionGroupingResult = {
  groups: [],
  groupedRequestIds: new Set(),
  groupByAnchorId: new Map(),
}

interface PendingContent {
  permissionRequestId: string
  toolCallId: string
  toolName?: string
  appId?: string
  irreversible?: boolean
}

function isToolExecution(content: unknown): boolean {
  return (content as { type?: string } | undefined)?.type === 'tool_execution'
}

/** Returns the pending payload if this tool_execution is awaiting approval, else null. */
function asPending(content: unknown): PendingContent | null {
  const c = content as (PendingContent & { type?: string; status?: string }) | undefined
  if (
    c?.type === 'tool_execution' &&
    c.status === 'pending_permission' &&
    typeof c.permissionRequestId === 'string' &&
    typeof c.toolCallId === 'string'
  ) {
    return c
  }
  return null
}

/**
 * Group the pending tools of each contiguous tool-execution run.
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

  const flush = () => {
    if (runPending.length >= MIN_GROUP_SIZE && runLastToolMessageId) {
      groups.push({ anchorMessageId: runLastToolMessageId, tools: runPending })
    }
    runPending = []
    runLastToolMessageId = undefined
  }

  for (const msgId of messageIds) {
    const content = messagesById[msgId]?.content
    if (isToolExecution(content)) {
      // Part of the current batch run — a completed/running tool keeps it alive.
      runLastToolMessageId = msgId
      const pending = asPending(content)
      if (pending) {
        runPending.push({
          requestId: pending.permissionRequestId,
          toolCallId: pending.toolCallId,
          toolName: pending.toolName ?? 'unknown',
          appId: pending.appId,
          irreversible: pending.irreversible === true,
        })
      }
    } else {
      // Agent text / image / etc. ends the batch run.
      flush()
    }
  }
  flush()

  if (groups.length === 0) return EMPTY_RESULT

  const groupedRequestIds = new Set<string>()
  const groupByAnchorId = new Map<string, PermissionGroup>()
  for (const g of groups) {
    groupByAnchorId.set(g.anchorMessageId, g)
    for (const t of g.tools) groupedRequestIds.add(t.requestId)
  }
  return { groups, groupedRequestIds, groupByAnchorId }
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
 * Cheap, stable string signature of the grouping-relevant state. Used as the
 * reactive zustand selector value in `usePermissionGroups`: a primitive string
 * stays referentially stable (Object.is) on unrelated message updates, so the
 * expensive `groupPendingPermissions` only re-runs when the result could differ.
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
      const pendingTag =
        c.status === 'pending_permission' && c.permissionRequestId
          ? `${c.permissionRequestId}${c.irreversible ? '!' : ''}`
          : ''
      parts.push(`${msgId}:${c.status ?? ''}:${pendingTag}`)
    } else if (parts.length > 0 && parts[parts.length - 1] !== '/') {
      parts.push('/')
    }
  }
  return sawTool ? parts.join('|') : ''
}
