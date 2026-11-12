/**
 * SplitHandle - Handle para redimensionar splits
 *
 * Uses unified Pointer Events with `setPointerCapture`: once the drag starts,
 * ALL subsequent pointer events route to this element even when the cursor is
 * over an iframe (Terminal, Code Editor, HTML previews) — those used to swallow
 * document-level mousemove/mouseup and freeze the drag. `beginResizeDrag()`
 * additionally sets `pointer-events: none` on every iframe as belt-and-suspenders.
 */

import React, { useCallback, useEffect, useRef, useState } from "react"
import { Platform, type View } from "react-native"
import { XStack, YStack } from "tamagui"
import { beginResizeDrag, endResizeDrag } from "../../lib/resizeGuard"
import type { SplitDirection } from "../../store/tilingStore"
import { useColors } from "../mca/primitives/useColors"
import { colors as semanticColors } from "../mca/primitives/colors"

interface Props {
  direction: SplitDirection
  onDrag: (delta: number, totalSize: number) => void
}

export function SplitHandle({ direction, onDrag }: Props) {
  const c = useColors()
  const [isDragging, setIsDragging] = useState(false)
  const startPosRef = useRef(0)
  const handleRef = useRef<HTMLDivElement | null>(null)
  const parentSizeRef = useRef(1000)
  const draggingRef = useRef(false)
  const pointerIdRef = useRef<number | null>(null)

  const isHorizontal = direction === "horizontal"

  const getPosition = useCallback(
    (e: PointerEvent): number => {
      return isHorizontal ? e.clientX : e.clientY
    },
    [isHorizontal],
  )

  const measureParent = useCallback(() => {
    const el = handleRef.current
    if (el?.parentElement) {
      parentSizeRef.current = isHorizontal
        ? el.parentElement.offsetWidth
        : el.parentElement.offsetHeight
    }
  }, [isHorizontal])

  // Handlers como refs para evitar recrearlos
  const onMoveRef = useRef<(e: PointerEvent) => void>(() => {})
  const onEndRef = useRef<(e: PointerEvent) => void>(() => {})
  // The exact listener functions attached to document for the active drag.
  const attachedListenersRef = useRef<{ move: (e: PointerEvent) => void; end: (e: PointerEvent) => void } | null>(null)

  const endDrag = useCallback(() => {
    if (!draggingRef.current) return
    draggingRef.current = false
    const pointerId = pointerIdRef.current
    pointerIdRef.current = null
    setIsDragging(false)

    document.body.style.cursor = ""
    document.body.style.userSelect = ""

    // Release pointer capture explicitly — the browser also releases it on
    // pointerup, but pointercancel / unmount paths benefit from the explicit
    // release (and it is a no-op if capture is already gone).
    if (pointerId !== null) {
      try {
        handleRef.current?.releasePointerCapture(pointerId)
      } catch {
        // capture already released or never taken — nothing to do
      }
    }

    // Remove exactly the document-level fallback listeners that were attached
    // at drag start. Reading onMoveRef.current here instead would miss the
    // original function if the ref was swapped mid-drag (onDrag identity
    // change) and leak it — a stale closure that still passes the
    // draggingRef/pointerId guards on the next drag.
    const attached = attachedListenersRef.current
    if (attached) {
      document.removeEventListener("pointermove", attached.move)
      document.removeEventListener("pointerup", attached.end)
      document.removeEventListener("pointercancel", attached.end)
      attachedListenersRef.current = null
    }

    endResizeDrag()
  }, [])

  useEffect(() => {
    onMoveRef.current = (e: PointerEvent) => {
      if (!draggingRef.current) return
      if (pointerIdRef.current !== null && e.pointerId !== pointerIdRef.current) return

      e.preventDefault()

      const currentPos = getPosition(e)
      const delta = currentPos - startPosRef.current
      startPosRef.current = currentPos

      onDrag(delta, parentSizeRef.current)
    }

    onEndRef.current = (e: PointerEvent) => {
      if (pointerIdRef.current !== null && e.pointerId !== pointerIdRef.current) return
      endDrag()
    }
  }, [getPosition, onDrag, endDrag])

  useEffect(() => {
    if (Platform.OS !== "web") return

    const element = handleRef.current
    if (!element) return

    const onStart = (e: PointerEvent) => {
      // Primary button / single touch only — ignore extra fingers and right-click.
      if (e.pointerType === "mouse" && e.button !== 0) return
      if (draggingRef.current) return

      e.preventDefault()
      e.stopPropagation()

      draggingRef.current = true
      pointerIdRef.current = e.pointerId
      setIsDragging(true)
      startPosRef.current = getPosition(e)
      measureParent()

      // Route ALL subsequent pointer events to this element — even when the
      // pointer moves over an iframe, which would otherwise swallow them.
      try {
        element.setPointerCapture(e.pointerId)
      } catch {
        // jsdom / browsers without capture support: the document-level
        // fallback listeners below still track the pointer, and the
        // resizeGuard's pointer-events:none shield keeps iframes from
        // eating the events.
      }

      document.body.style.cursor = isHorizontal ? "col-resize" : "row-resize"
      document.body.style.userSelect = "none"
      beginResizeDrag()

      // Fallback listeners on document — belt-and-suspenders for browsers or
      // situations where pointer capture is unavailable or gets lost. The
      // exact functions are recorded so endDrag can remove them even if the
      // onMove/onEnd refs are swapped mid-drag.
      const move = onMoveRef.current!
      const end = onEndRef.current!
      attachedListenersRef.current = { move, end }
      document.addEventListener("pointermove", move)
      document.addEventListener("pointerup", end)
      document.addEventListener("pointercancel", end)
    }

    element.addEventListener("pointerdown", onStart)

    return () => {
      element.removeEventListener("pointerdown", onStart)
      // If a drag is still active at unmount, endDrag removes the tracked
      // listeners; otherwise remove whatever this effect attached (none).
      endDrag()
    }
  }, [isHorizontal, getPosition, measureParent, endDrag])

  const setRef = useCallback((node: View | null) => {
    if (Platform.OS === "web" && node) {
      handleRef.current = node as unknown as HTMLDivElement
    }
  }, [])

  const Container = isHorizontal ? YStack : XStack
  const Indicator = isHorizontal ? YStack : XStack

  return (
    <Container
      ref={setRef as any}
      // A hairline between panes (`.win + .win`), with an 8px grab area that
      // lights up in the accent while hovered / dragged.
      {...(isHorizontal ? { width: 8, marginHorizontal: -4 } : { height: 8, marginVertical: -4 })}
      flexShrink={0}
      zIndex={5}
      backgroundColor="transparent"
      cursor={isHorizontal ? "col-resize" : "row-resize"}
      justifyContent="center"
      alignItems="center"
      hoverStyle={{ backgroundColor: "rgba(111,39,255,0.06)" }}
      style={{ touchAction: "none", userSelect: "none" }}
    >
      <Indicator
        {...(isHorizontal
          ? { width: isDragging ? 2 : 1, height: "100%" }
          : { width: "100%", height: isDragging ? 2 : 1 })}
        backgroundColor={isDragging ? semanticColors.purple300 : c.border}
        pointerEvents="none"
      />
    </Container>
  )
}
