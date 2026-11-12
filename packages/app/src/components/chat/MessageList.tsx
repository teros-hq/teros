/**
 * MessageList — the scrolling thread of a chat, CHRONOLOGICAL from the
 * caller's point of view: `ids[0]` is the oldest message, the last id is the
 * live tail. `header` renders at the visual top (load earlier), `footer` at
 * the visual bottom (the voice section / receipt).
 *
 * Native: an inverted FlatList (the platform's native way to anchor a list to
 * its bottom), fed the ids reversed — the inversion is an implementation
 * detail that never leaks to ChatView. Web has its own file
 * (`MessageList.web.tsx`): a plain bottom-anchored scroller, because the
 * inverted FlatList on the web is a `scaleY(-1)` transform that breaks the
 * wheel, text selection, scrollbars and find-in-page.
 */
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react"
import {
  FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  StyleSheet,
} from "react-native"

// Sticky margin: the pin holds while the reader is at the bottom or within
// the last 50px of the thread — a nudge inside that band does not release
// the follow; scrolling past it does (and brings the jump arrow back).
const BOTTOM_SLACK = 50

export interface MessageListHandle {
  scrollToBottom: (animated?: boolean) => void
}

/** Where the reader is relative to the live tail. */
export interface TailState {
  /** At the bottom: the thread follows new content. */
  pinned: boolean
  /** Rows were appended while the reader was scrolled up. */
  unseen: boolean
}

export interface MessageListProps {
  /** Chronological ids (oldest first). May include sentinel ids. */
  ids: string[]
  /** Renders one row; `index` is the CHRONOLOGICAL index into `ids`. */
  renderItem: (id: string, index: number) => React.ReactElement | null
  /** Visual top of the thread. */
  header?: React.ReactNode
  /** Visual bottom of the thread, after the last message. */
  footer?: React.ReactNode
  /** Fires when the pin arms/releases or unseen content appears/clears. */
  onTailChange?: (state: TailState) => void
}

export const MessageList = forwardRef<MessageListHandle, MessageListProps>(function MessageList(
  { ids, renderItem, header, footer, onTailChange },
  ref,
) {
  const listRef = useRef<FlatList<string>>(null)
  const reversed = useMemo(() => [...ids].reverse(), [ids])
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

  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom: (animated = true) => {
        setTail({ pinned: true, unseen: false })
        listRef.current?.scrollToOffset({ offset: 0, animated })
      },
    }),
    [setTail],
  )

  // Rows appended while scrolled up → unseen.
  useEffect(() => {
    const last = ids[ids.length - 1]
    if (last !== lastIdRef.current && !tailRef.current.pinned) setTail({ unseen: true })
    lastIdRef.current = last
  }, [ids, setTail])

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const pinned = e.nativeEvent.contentOffset.y <= BOTTOM_SLACK
      setTail(pinned ? { pinned: true, unseen: false } : { pinned: false })
    },
    [setTail],
  )

  const render = useCallback(
    ({ item, index }: { item: string; index: number }) =>
      renderItem(item, reversed.length - 1 - index),
    [renderItem, reversed.length],
  )

  return (
    <FlatList
      ref={listRef}
      data={reversed}
      renderItem={render}
      keyExtractor={keyOf}
      style={styles.list}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      inverted
      onScroll={onScroll}
      scrollEventThrottle={64}
      initialNumToRender={20}
      maxToRenderPerBatch={10}
      windowSize={11}
      // Inverted: the FlatList's header is the visual bottom.
      ListHeaderComponent={footer ? <>{footer}</> : null}
      ListFooterComponent={header ? <>{header}</> : null}
    />
  )
})

const keyOf = (id: string) => id

const styles = StyleSheet.create({
  list: { flex: 1 },
  content: { paddingVertical: 24, flexGrow: 1 },
})
