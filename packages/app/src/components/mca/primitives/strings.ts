/**
 * Centralised copy for the MCA renderer primitives.
 *
 * The permission widget's copy already moved to the app i18n
 * (`mca.permission*`, PERMW-REQ-5). What remains here is en-US only and
 * migrates the same way: replace the constant with `t('mca.…')` where it
 * is consumed. Never inline a literal in a primitive.
 *
 * Why constants and not template strings? Because template strings
 * with interpolation (`{count}`) leak across the i18n boundary.
 * Function-shaped builders (`status(name) => …`) get migrated more
 * cleanly to `t('key', { name })`.
 */

export const MCA_STRINGS = {
  // The permission widget's copy (permission, permissionGroup, permissionDetail)
  // lives in the app i18n under `mca.permission*` so the chat and the navbar
  // read in the same language (PERMW-REQ-5).
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
