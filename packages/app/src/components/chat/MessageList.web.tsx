/**
 * MessageList (web) — a plain, chronological, bottom-anchored scroller.
 *
 * No inverted FlatList here: on the web that is a `scaleY(-1)` transform on
 * the scroller and on every row, which inverts the wheel and the trackpad,
 * breaks text selection and find-in-page, mirrors the scrollbar and fights
 * every browser scroll heuristic. The DOM already knows how to scroll a
 * column of messages — this component only adds the chat rules on top of a
 * normal `overflow: auto` div:
 *
 *   1. PINNED TO THE BOTTOM while the reader is at (or within 50px of) it:
 *      any growth of the content — a streaming reply, an image that loads, a
 *      tool card that expands, the composer growing — keeps the tail in
 *      view. Scroll up and the pin releases; scroll back down and it re-arms.
 *   2. ANCHORED TO A ROW otherwise: the first row visible at the top of the
 *      viewport is the anchor, and whenever the content changes height —
 *      older history prepended, a row above growing late (markdown, fonts,
 *      images) — the scroller is offset so that row stays exactly where the
 *      reader sees it. Browser scroll anchoring does this in Chrome and
 *      Firefox only; doing it here covers Safari and keeps one behaviour.
 *   3. SHORT THREADS SIT AT THE BOTTOM, like the inverted list did, by
 *      laying the content out as a column justified to the end.
 *
 * Not virtualised: the thread is paged by the backend and rows are plain
 * DOM, which the browser handles comfortably into the hundreds of rows.
 */
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react"
import type { MessageListHandle, MessageListProps, TailState } from "./MessageList"

export type { MessageListHandle, MessageListProps, TailState } from "./MessageList"

// Sticky margin: the pin holds while the reader is at the bottom or within
// the last 50px of the thread — a nudge inside that band does not release
// the follow; scrolling past it does (and brings the jump arrow back).
const BOTTOM_SLACK = 50
// A scroll event counts as our own echo only if it lands on the value we
// wrote within this window — instant writes echo within a frame; smooth
// scrolls are covered separately by `smoothUntilRef`. Without the window,
// a genuine user scroll that lands on the same value LATER (wheeling back
// down to the bottom lands exactly where the pin last wrote) is swallowed
// and the pin never re-arms.
const ECHO_WINDOW_MS = 120

type Anchor = { id: string; offset: number }

export const MessageList = forwardRef<MessageListHandle, MessageListProps>(function MessageList(
  { ids, renderItem, header, footer, onTailChange },
  ref,
) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  // Armed while the reader is at the bottom. Starts armed: a thread opens on
  // its live tail.
  const pinnedRef = useRef(true)
  // The row the reader is looking at while not pinned, and where its top sits
  // relative to the viewport's top.
  const anchorRef = useRef<Anchor | null>(null)
  // What ChatView is told: the pin, and whether rows arrived unseen.
  const tailRef = useRef<TailState>({ pinned: true, unseen: false })
  const lastIdRef = useRef<string | undefined>(ids[ids.length - 1])
  const setTail = useCallback(
    (next: Partial<TailState>) => {
      const cur = tailRef.current
      const merged = { ...cur, ...next }
      if (merged.pinned === cur.pinned && merged.unseen === cur.unseen) return
      tailRef.current = merged
      onTailChange?.(merged)
    },
    [onTailChange],
  )

  // Our own scrollTop writes fire `scroll` events too — asynchronously, so
  // a flag around the write is not enough. Remember the value we wrote (and
  // WHEN) and treat a scroll event as an echo only if it lands on that value
  // within the echo window; smooth scrolls are covered by smoothUntilRef.
  // Only the reader's own scrolling may arm or release the pin.
  const lastWriteRef = useRef<{ top: number; at: number }>({ top: -1, at: 0 })
  const smoothUntilRef = useRef(0)
  // True only after the reader's OWN scroll gesture (wheel/touch/keys). The
  // settle-release below exists so a wheel-up mid-stream wins over the pin's
  // writes — but on initial mount the content arrives async while scrollTop
  // is still 0, and without this guard the first settle() would read
  // "not at bottom" and release a pin the reader never touched, leaving the
  // conversation stuck at the top.
  const userScrolledRef = useRef(false)
  const debug = typeof __DEV__ !== "undefined" && __DEV__

  const rowTop = (el: HTMLElement, row: HTMLElement) =>
    row.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop

  const setScrollTop = (el: HTMLElement, top: number) => {
    el.scrollTop = top
    lastWriteRef.current = { top: el.scrollTop, at: performance.now() }
  }

  const note = (el: HTMLElement, what: string) => {
    if (!debug) return
    el.dataset.pinned = String(pinnedRef.current)
    el.dataset.anchor = anchorRef.current
      ? `${anchorRef.current.id}@${anchorRef.current.offset}`
      : ""
    const log = ((el as any).__mlLog ??= [] as string[])
    if (log.length < 200)
      log.push(
        `${Math.round(performance.now())} ${what} top=${Math.round(el.scrollTop)} max=${el.scrollHeight - el.clientHeight}`,
      )
  }

  const pinToBottom = useCallback((animated: boolean) => {
    const el = scrollerRef.current
    if (!el) return
    const reduced =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
    const top = el.scrollHeight - el.clientHeight
    if (animated && !reduced && typeof el.scrollTo === "function") {
      smoothUntilRef.current = performance.now() + 700
      lastWriteRef.current = { top, at: performance.now() }
      el.scrollTo({ top, behavior: "smooth" })
    } else {
      setScrollTop(el, top)
    }
    note(el, "pin")
  }, [])

  // Remember which row sits at the top of the viewport (and where).
  const captureAnchor = useCallback(() => {
    const el = scrollerRef.current
    const content = contentRef.current
    if (!el || !content) return
    const rows = content.querySelectorAll<HTMLElement>("[data-row]")
    for (const row of Array.from(rows)) {
      const top = rowTop(el, row)
      if (top + row.offsetHeight > el.scrollTop) {
        anchorRef.current = { id: row.dataset.row as string, offset: top - el.scrollTop }
        return
      }
    }
    anchorRef.current = null
  }, [])

  // Put the anchored row back where it was.
  const restoreAnchor = useCallback(() => {
    const el = scrollerRef.current
    const content = contentRef.current
    const anchor = anchorRef.current
    if (!el || !content || !anchor) return
    const row = content.querySelector<HTMLElement>(`[data-row="${CSS.escape(anchor.id)}"]`)
    if (!row) return
    const target = Math.max(0, rowTop(el, row) - anchor.offset)
    if (Math.abs(target - el.scrollTop) >= 1) setScrollTop(el, target)
    note(el, "restore")
  }, [])

  // Content changed height (ids changed, or a row grew): hold the reader's
  // place — the tail if pinned, the anchored row otherwise. But the reader
  // comes first: while streaming, the pin writes the bottom on every chunk,
  // and a wheel-up can land between two writes. If they are no longer at the
  // tail when we settle, their move wins — release the pin and anchor where
  // they are instead of writing over them (that write was what snapped the
  // viewport back down mid-stream).
  const settle = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    if (pinnedRef.current) {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK
      if (!atBottom && userScrolledRef.current) {
        pinnedRef.current = false
        captureAnchor()
        setTail({ pinned: false })
        note(el, "release")
        return
      }
      pinToBottom(false)
    } else {
      restoreAnchor()
    }
  }, [pinToBottom, restoreAnchor, captureAnchor, setTail])

  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom: (animated = true) => {
        pinnedRef.current = true
        anchorRef.current = null
        userScrolledRef.current = false
        setTail({ pinned: true, unseen: false })
        pinToBottom(animated)
      },
    }),
    [pinToBottom, setTail],
  )

  // The reader moves: re-arm or release the pin, and re-anchor.
  const onScroll = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    if (performance.now() < smoothUntilRef.current) return
    const write = lastWriteRef.current
    if (
      write.top >= 0 &&
      Math.abs(el.scrollTop - write.top) < 1 &&
      performance.now() - write.at < ECHO_WINDOW_MS
    ) {
      note(el, "echo")
      return
    }
    userScrolledRef.current = true
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK
    if (pinnedRef.current) {
      anchorRef.current = null
      setTail({ pinned: true, unseen: false })
    } else {
      captureAnchor()
      setTail({ pinned: false })
    }
    note(el, "scroll")
  }, [captureAnchor, setTail])

  // Content or viewport resized (streaming text, images, markdown settling,
  // the composer growing, the window resizing).
  useEffect(() => {
    const el = scrollerRef.current
    const content = contentRef.current
    if (!el || !content || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(settle)
    ro.observe(content)
    ro.observe(el)
    return () => ro.disconnect()
  }, [settle])

  // Rows changed (append, prepend, sentinel in/out): settle before paint,
  // and flag rows that arrived while the reader was up the thread.
  useLayoutEffect(() => {
    settle()
    const last = ids[ids.length - 1]
    if (last !== lastIdRef.current && !pinnedRef.current) setTail({ unseen: true })
    lastIdRef.current = last
  }, [ids, settle, setTail])

  // Opening a conversation (or switching tabs to one) must land at the very
  // bottom, sticky — not at the first message. The pin starts armed, but the
  // first frames race: the div mounts with scrollTop 0, history streams in
  // from the store, and only when the content finally overflows does the
  // ResizeObserver's settle() get a chance to write the bottom — usually
  // AFTER a paint of the thread's head. Force the bottom write as soon as
  // the content first overflows the viewport; from there the pin and the
  // observer keep the tail in view on their own.
  const enteredRef = useRef(false)
  useEffect(() => {
    const el = scrollerRef.current
    const content = contentRef.current
    if (!el || !content || enteredRef.current) return
    if (content.scrollHeight <= el.clientHeight) return
    enteredRef.current = true
    if (pinnedRef.current) pinToBottom(false)
  }, [ids, pinToBottom])

  return (
    <div
      ref={scrollerRef}
      className="chat-scroll"
      data-testid="message-list"
      onScroll={onScroll}
      style={{
        position: "absolute",
        inset: 0,
        overflowY: "auto",
        overflowX: "hidden",
        overscrollBehavior: "contain",
        overflowAnchor: "none",
        WebkitOverflowScrolling: "touch",
      }}
    >
      <div
        ref={contentRef}
        style={{
          minHeight: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-end",
          paddingTop: 24,
          paddingBottom: 24,
          boxSizing: "border-box",
        }}
      >
        {header}
        {ids.map((id, i) => (
          // A real box per row (not `display: contents`) so the anchor has
          // geometry; a flex column so rows' `alignSelf: center` still works.
          <div
            key={id}
            data-row={id}
            style={{ display: "flex", flexDirection: "column", flexShrink: 0 }}
          >
            {renderItem(id, i)}
          </div>
        ))}
        {footer}
      </div>
    </div>
  )
})
