/**
 * The latency lane of an agent turn (TLANE-REQ-2): derived from what started
 * the turn, never from the channel. `channel.headless` is not a signal — the
 * G2 and Even Terminal channels are headless while a person waits on them.
 *
 * @spec TLANE-REQ-2
 */
import type { TerosLane } from "../models/providers/teros.js"
import type { AgentUsageTriggerKind } from "../types/database.js"

/** @spec TLANE-REQ-2 */
export function laneForTrigger(triggerKind: AgentUsageTriggerKind): TerosLane {
  switch (triggerKind) {
    case "user_message":
      return "interactive"
    // Delegations are slated for removal (Pablo, 2026-11-09); until then a
    // delegated child runs on the lane where nobody is ever kept waiting.
    case "delegation":
      return "interactive"
    case "scheduled":
    case "autorun":
    case "event_subscription":
      return "background"
  }
}
