/**
 * `.msg-actions` (thumbs / copy / report / redact) gate: only under the LAST
 * message of the channel, and only once the agent's turn is over (control is
 * back with the user). Historical / intermediate messages and live turns get
 * no row. Ratings live in the backend, so hiding the row loses nothing.
 */
export function shouldShowMsgActions(o: {
  isLastMessage: boolean
  turnDone: boolean
  isStreaming: boolean
}): boolean {
  return o.isLastMessage && o.turnDone && !o.isStreaming
}
