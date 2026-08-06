/**
 * Per renderer-ux-guide §7 DO list: "Limit list display to 50 items max".
 * Use this constant in renderer `.slice(0, MAX_ITEMS)` instead of hardcoded
 * numbers. Bridge throughput in RN degrades sharply past this threshold.
 *
 * If a renderer needs a smaller cap for UX reasons (e.g. chat with last N
 * messages), document the deviation inline and keep the local literal.
 */
export const MAX_ITEMS = 50;
