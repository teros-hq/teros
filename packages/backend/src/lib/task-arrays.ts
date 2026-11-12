/**
 * Caps for the arrays embedded in task documents (MOD-3).
 *
 * Task.activity and Task.progressNotes grew without bound with every move,
 * wake and note. The complete history lives in board_events; the embedded
 * arrays are the recent window the board UI renders, so pushes keep only the
 * newest entries. (Moving the UI to board_events and dropping the arrays is
 * the static-documents end state — MOD-2.)
 */

export const TASK_ACTIVITY_CAP = 500
export const TASK_PROGRESS_NOTES_CAP = 200

/** `$push` operand that appends and keeps only the newest `cap` entries. */
export function cappedPush<T>(entries: T | T[], cap: number): { $each: T[]; $slice: number } {
  return { $each: Array.isArray(entries) ? entries : [entries], $slice: -cap }
}
