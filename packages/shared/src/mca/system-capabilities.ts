/**
 * System capabilities — shared taxonomy (v1.4.4)
 *
 * Single source of truth for the three capability groups rendered in the
 * agent's "System capabilities" section and used by the backend to classify
 * system MCAs. Backend and frontend both import from here so the grouping can
 * never drift between the toggle API (agent.disabledSystemApps /
 * agent.enabledSystemApps) and the UI.
 *
 * Groups (Pablo, 30-oct — confirmed):
 * - ambient:     always on, no toggle (messaging, conversations, guide, …)
 * - toggleable:  default ON, user can disable (memory, tasks, boards, …)
 * - power:       default OFF, explicit activation (terminal, filesystem, …)
 *
 * The power group lives INSIDE System capabilities (not third-party apps):
 * its MCAs are system:true + hidden:true + defaultEnabled:false — the toggle
 * IS their grant. "Terminal" is bash + terminal unified as ONE entry
 * (capability group — see mca-service SYSTEM_CAPABILITY_GROUPS).
 *
 * Out of scope here (Fase 2): availability.class field, approval tiers,
 * mca.teros.core, datetime→Context rename.
 */

/** Capability group kinds, in UI display order. */
export type SystemCapabilityGroup = 'ambient' | 'toggleable' | 'power';

export interface SystemCapabilityDef {
  /** User-facing capability id (not an mcaId — one capability may map to several MCAs). */
  id: string;
  /** All MCAs backing this capability. */
  mcaIds: string[];
  group: SystemCapabilityGroup;
}

/**
 * The system capabilities, keyed by capability id.
 * MCAs NOT listed here but marked availability.system in the catalog are
 * ambient-by-default and render in the collapsed ambient list (see
 * classifySystemMca).
 */
export const SYSTEM_CAPABILITIES: Record<string, SystemCapabilityDef> = {
  // ── Ambient (always on, no toggle) ──────────────────────────────────────
  messaging: { id: 'messaging', mcaIds: ['mca.teros.messaging'], group: 'ambient' },
  conversations: { id: 'conversations', mcaIds: ['mca.teros.conversations'], group: 'ambient' },
  guide: { id: 'guide', mcaIds: ['mca.teros.guide'], group: 'ambient' },
  'file-processor': { id: 'file-processor', mcaIds: ['mca.teros.file-processor'], group: 'ambient' },
  datetime: { id: 'datetime', mcaIds: ['mca.teros.datetime'], group: 'ambient' },
  feedback: { id: 'feedback', mcaIds: ['mca.teros.feedback'], group: 'ambient' },

  // ── Toggleable (default ON, user can disable) ───────────────────────────
  memory: { id: 'memory', mcaIds: ['mca.teros.memory'], group: 'toggleable' },
  tasks: { id: 'tasks', mcaIds: ['mca.teros.todo-list'], group: 'toggleable' },
  boards: { id: 'boards', mcaIds: ['mca.teros.board-manager', 'mca.teros.board-runner'], group: 'toggleable' },
  automate: { id: 'automate', mcaIds: ['mca.teros.automate'], group: 'toggleable' },
  workflows: { id: 'workflows', mcaIds: ['mca.teros.workflows'], group: 'toggleable' },

  // ── Power (default OFF, explicit activation — toggle IS the grant) ──────
  terminal: { id: 'terminal', mcaIds: ['mca.teros.bash', 'mca.teros.terminal'], group: 'power' },
  filesystem: { id: 'filesystem', mcaIds: ['mca.teros.filesystem'], group: 'power' },
  browser: { id: 'browser', mcaIds: ['mca.teros.browser'], group: 'power' },
  ui: { id: 'ui', mcaIds: ['mca.teros.ui'], group: 'power' },
};

/** Reverse index: mcaId → capability id. */
const MCA_TO_CAPABILITY = new Map<string, string>();
for (const cap of Object.values(SYSTEM_CAPABILITIES)) {
  for (const mcaId of cap.mcaIds) MCA_TO_CAPABILITY.set(mcaId, cap.id);
}

/** All mcaIds belonging to a group (e.g. every power mcaId). */
export function systemMcaIdsByGroup(group: SystemCapabilityGroup): string[] {
  return Object.values(SYSTEM_CAPABILITIES)
    .filter((c) => c.group === group)
    .flatMap((c) => c.mcaIds);
}

/**
 * Classify a system mcaId. Returns the capability id when the MCA belongs to
 * a declared capability, else null (unknown system MCAs — e.g. admin-gated
 * ones — are not user-facing capabilities).
 */
export function capabilityForMca(mcaId: string): string | null {
  return MCA_TO_CAPABILITY.get(mcaId) ?? null;
}

/**
 * Is this mcaId a system capability MCA at all (any group)?
 * Used by the prompt builder to exclude system apps from "Your installed
 * apps" — their tools are already exposed as flat tools with their own
 * descriptions; listing them as apps adds noise, not signal.
 */
export function isSystemCapabilityMca(mcaId: string): boolean {
  return MCA_TO_CAPABILITY.has(mcaId);
}
