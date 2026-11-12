/**
 * The colour of the progress fill drawn behind a task row (tree and day views):
 * the state's own colour at low alpha, so a half-done blocked task reads red
 * the way a half-done working task reads amber (TODORF-REQ-1).
 */
import type { NodeState } from "../model/types"
import type { TodoTokens } from "./tokens"

/** @spec TODORF-REQ-1 */
export function progressFill(td: TodoTokens, state: NodeState | null | undefined): string {
  switch (state) {
    case "review":
      return td.progRev
    case "working":
      return td.progWorking
    case "pending":
      return td.progPending
    case "blocked":
      return td.progBlocked
    default:
      return td.progBg
  }
}
