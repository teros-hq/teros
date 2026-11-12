/**
 * overlayPresence — "is a modal overlay open right now?" for the whole SPA.
 *
 * The desktop shell's native browser views (Teros Desktop F2) composite ABOVE
 * all DOM of their rectangle: a modal that opens over a browser pane is
 * painted under the page. The F2 Overlay rule (spec §4) is that while any
 * modal overlay is open the native views hide, so the DOM overlay shows
 * through. This module is the signal those views subscribe to.
 *
 * Teros has no central modal registry: dialogs are `react-native-web`
 * `<Modal>`s (the permission sheet, agent/board dialogs…) and Tamagui
 * `<Dialog>`s (confirmations, retention warning…) opened from many places.
 * Both primitives mark their content with `aria-modal="true"` — RNW on its
 * ModalContent, Tamagui on its DialogContent (and `data-state="closed"`
 * during the exit animation). So instead of wiring every call site, the
 * presence is observed from the document: one MutationObserver on
 * `document.body` watching for connected `[aria-modal="true"]` elements that
 * are not closing. Any modal built on either primitive, present or future,
 * is covered without touching it.
 *
 * Cheap by construction: the observer only re-evaluates when a mutation
 * record adds/removes a subtree containing a modal marker or flips one of
 * the watched attributes; chat streaming and layout churn never trigger a
 * document query. The observer runs only while someone is subscribed.
 */

import { useSyncExternalStore } from "react"

/** What counts as a modal overlay in the document. */
export const MODAL_OVERLAY_SELECTOR = '[aria-modal="true"]'

/** Attributes whose change can open or close an overlay without a DOM add/remove. */
const WATCHED_ATTRIBUTES = ["aria-modal", "data-state", "aria-hidden"]

function isOpenOverlay(el: Element): boolean {
  // Tamagui keeps the content mounted with data-state="closed" while it
  // animates out; RNW unmounts. Either way "closed" is not open.
  if (el.getAttribute("data-state") === "closed") return false
  if (el.getAttribute("aria-hidden") === "true") return false
  return true
}

/**
 * Whether a modal overlay is open in `root` (the document by default).
 * Synchronous read — the hook below is the subscribable version.
 */
export function isOverlayOpen(
  root: ParentNode | null = typeof document === "undefined" ? null : document,
): boolean {
  if (!root) return false
  const candidates = root.querySelectorAll(MODAL_OVERLAY_SELECTOR)
  for (let i = 0; i < candidates.length; i++) {
    if (isOpenOverlay(candidates[i])) return true
  }
  return false
}

function touchesOverlay(node: Node): boolean {
  if (node.nodeType !== 1) return false
  const el = node as Element
  return el.matches(MODAL_OVERLAY_SELECTOR) || el.querySelector(MODAL_OVERLAY_SELECTOR) !== null
}

/** Does this batch of mutations possibly change the answer? */
function relevant(records: MutationRecord[]): boolean {
  for (const r of records) {
    if (r.type === "attributes") return true // filtered to WATCHED_ATTRIBUTES already
    for (let i = 0; i < r.addedNodes.length; i++) if (touchesOverlay(r.addedNodes[i])) return true
    for (let i = 0; i < r.removedNodes.length; i++)
      if (touchesOverlay(r.removedNodes[i])) return true
  }
  return false
}

const listeners = new Set<() => void>()
let observer: MutationObserver | null = null
let current = false

function evaluate() {
  const next = isOverlayOpen()
  if (next === current) return
  current = next
  for (const l of listeners) l()
}

function start() {
  if (observer) return
  if (typeof document === "undefined" || typeof MutationObserver === "undefined" || !document.body)
    return
  current = isOverlayOpen()
  observer = new MutationObserver((records) => {
    if (relevant(records)) evaluate()
  })
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: WATCHED_ATTRIBUTES,
  })
}

function stop() {
  observer?.disconnect()
  observer = null
}

/**
 * Subscribe to overlay presence changes. The observer is started with the
 * first subscriber and stopped with the last. Returns the unsubscribe.
 */
export function subscribeOverlayPresence(listener: () => void): () => void {
  listeners.add(listener)
  start()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) stop()
  }
}

function getSnapshot(): boolean {
  // Before the observer runs (first render) read the document directly.
  return observer ? current : isOverlayOpen()
}

function getServerSnapshot(): boolean {
  return false
}

/** True while a modal overlay is open anywhere in the document. */
export function useOverlayOpen(): boolean {
  return useSyncExternalStore(subscribeOverlayPresence, getSnapshot, getServerSnapshot)
}
