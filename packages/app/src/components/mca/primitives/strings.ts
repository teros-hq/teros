/**
 * Centralised copy for the MCA renderer primitives.
 *
 * NOT yet wired to a full i18n library — this is a single point of
 * truth so that when Teros adopts react-i18next or expo-localization
 * the migration is one operation: replace these constants with
 * `t('mca.permission.awaiting')` everywhere they are consumed.
 *
 * Locale today: en-US. A separate sub-issue tracks the i18n adoption
 * once the rest of the app catches up. Until then, every new string
 * shown by the MCA renderer subsystem belongs here — never inline a
 * literal in a primitive again.
 *
 * Why constants and not template strings? Because template strings
 * with interpolation (`{count}`) leak across the i18n boundary.
 * Function-shaped builders (`status(name) => …`) get migrated more
 * cleanly to `t('key', { name })`.
 */

export const MCA_STRINGS = {
  permission: {
    awaiting: 'Awaiting your approval',
    deny: 'Deny',
    allow: 'Allow',
    denyAlways: 'Deny always',
    allowAlways: 'Allow always',
    cancel: 'Cancel',
    permissionRequired: 'Permission required',
    blockTool: 'Block this tool permanently',
    rejectOnly: 'Reject this execution only',
    allowOnly: 'Allow this execution only',
    dontAskAgain: "Don't ask again for this tool",
    irreversible: 'irreversible',
    moreOptions: 'More permission options',
    irreversibleAriaLabel: 'This action cannot be undone',
    // Per guide v2.1 §8.5: binary marker. The literal "risk" matches the
    // shape of "irreversible" — no gradations implied. Saying "high risk"
    // would suggest a "low risk" tier that the spec explicitly rejects.
    risk: 'risk',
    riskAriaLabel: 'Elevated risk: this action affects security or has a wide blast radius',
  },
  // Grouped permission bar (TER-375) — shown when ≥2 tools fired in parallel
  // share one approval widget instead of N stacked ControlsBars.
  permissionGroup: {
    allowAll: 'Allow all',
    denyAll: 'Deny all',
    /** Panel header, e.g. "3 actions need your approval". */
    awaiting: (count: number) => `${count} actions need your approval`,
    /** Sub-label when some (not all) tools are destructive — "Allow all" skips them. */
    destructiveNote: (count: number) =>
      `${count} destructive — decide individually`,
    /** Sub-label when every tool in the group is destructive. */
    allDestructiveNote: 'Destructive actions — decide individually',
  },
  tense: {
    will: 'Will',
    failedTo: 'Failed to',
    wantsTo: 'Wants to',
  },
  fallback: {
    output: 'Output',
    noParams: 'No params',
  },
  /**
   * Status descriptions for accessibility — read aloud by screen
   * readers when focus lands on a `<StatusDot>`. Keep them short
   * (≤ 4 words). The colour + pulse are decorative; this label is
   * the primary signal for non-visual users.
   */
  status: {
    pending: 'pending, queued',
    running: 'running, in progress',
    completed: 'completed successfully',
    failed: 'failed',
    pending_permission: 'awaiting your approval',
    pending_user_input: 'waiting for you to fill a form',
  },
  // NOTE: the inline-form widget (FormWidget) deliberately does NOT use
  // MCA_STRINGS — it is end-user chat UI, so its copy lives in the app i18n
  // (formWidget.* in src/i18n/locales) and follows the interface language.
} as const;

export type McaStrings = typeof MCA_STRINGS;
