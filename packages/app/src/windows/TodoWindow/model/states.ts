/**
 * Task states: order, colours and allowed transitions (task-states spec §7
 * without the reviewer role — mirrors STATE_TRANSITIONS in packages/backend/src/mca-actions/todo.ts).
 * `cancelled` (Pablo, 2026-10-30): reachable from every open state, reopens
 * to pending, leaves the day plan and is ignored by autoplay.
 */
import type { NodeState } from "./types"

export const STATE_ORDER: NodeState[] = ["planning", "pending", "working", "blocked", "review", "done", "cancelled"]

export const STATE_TRANSITIONS: Record<NodeState, NodeState[]> = {
  planning: ["pending", "cancelled"],
  pending: ["working", "done", "planning", "cancelled"],
  working: ["review", "blocked", "pending", "done", "cancelled"],
  blocked: ["working", "planning", "cancelled"],
  review: ["done", "working", "cancelled"],
  done: ["working"],
  cancelled: ["pending"],
}

// State colours are theme tokens: `useTd().st[state]` (ui/tokens.ts).

/** Open = neither finished (done) nor called off (cancelled). */
export const isOpenState = (s: NodeState | null | undefined) => s != null && s !== "done" && s !== "cancelled"
