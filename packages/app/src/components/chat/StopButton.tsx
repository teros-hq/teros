import React, { useCallback, useMemo, useRef, useState } from "react"
import type { GestureResponderEvent } from "react-native"
import { Pressable } from "react-native"
import { useColors } from "../mca/primitives/useColors"
import { Ph } from "../ui/ds"
import { t } from "../../lib/i18n"
import { HardCancelModal } from "./HardCancelModal"

const LONG_PRESS_MS = 500

interface StopButtonProps {
  onSoftStop: () => void | Promise<void>
  onHardStop: () => void | Promise<void>
  hasIrreversibleToolInFlight?: boolean
  irreversibleToolName?: string
}

/**
 * `.send.stop` — the composer's STOP state: the 48px ink pill (inverted)
 * with a stop glyph. Tap = soft stop; hold (or Shift+click / Shift+Enter) =
 * the hard-cancel confirmation. While holding, a ring grows around the pill
 * (`.send.stop.holding`) so the long press reads as progress.
 */
export function StopButton({
  onSoftStop,
  onHardStop,
  hasIrreversibleToolInFlight = false,
  irreversibleToolName,
}: StopButtonProps): React.ReactElement {
  const c = useColors()
  const [modalOpen, setModalOpen] = useState(false)
  const [holding, setHolding] = useState(false)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressFired = useRef(false)

  const clearTimer = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
    setHolding(false)
  }, [])

  const handlePressIn = useCallback(() => {
    longPressFired.current = false
    setHolding(true)
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true
      setHolding(false)
      setModalOpen(true)
    }, LONG_PRESS_MS)
  }, [])

  const handlePressOut = useCallback(() => {
    clearTimer()
  }, [clearTimer])

  const handlePress = useCallback(
    (e: GestureResponderEvent) => {
      clearTimer()
      const native = (e as { nativeEvent?: { shiftKey?: boolean } }).nativeEvent
      const shiftKey = native?.shiftKey ?? false
      if (longPressFired.current || shiftKey) {
        if (shiftKey && !modalOpen) setModalOpen(true)
        return
      }
      void onSoftStop()
    },
    [clearTimer, modalOpen, onSoftStop],
  )

  const handleHardConfirm = useCallback(async () => {
    setModalOpen(false)
    await onHardStop()
  }, [onHardStop])

  const handleKeyDown = useCallback(
    (e: { shiftKey?: boolean; key?: string; preventDefault?: () => void }) => {
      if (e.shiftKey && e.key === "Enter") {
        e.preventDefault?.()
        setModalOpen(true)
      }
    },
    [],
  )

  const holdCss = useMemo(
    () => `
      @keyframes stopHoldRing {
        from { box-shadow: 0 0 0 0 ${c.navActive}; }
        to { box-shadow: 0 0 0 8px ${c.navActive}; }
      }
      .stop-btn-holding { animation: stopHoldRing ${LONG_PRESS_MS}ms linear forwards; }
      .stop-btn:focus-visible { outline: 2px solid ${c.accent}; outline-offset: 2px; }
    `,
    [c.navActive, c.accent],
  )

  return (
    <>
      <style>{holdCss}</style>
      <Pressable
        testID="composer-stop"
        accessibilityRole="button"
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        onPress={handlePress}
        aria-label={t("chat.stop.ariaLabel")}
        // `onKeyDown` / aria-describedby / className land on the DOM element via RN-Web prop forwarding.
        {...({
          onKeyDown: handleKeyDown,
          "aria-describedby": "stop-btn-hint",
          className: holding ? "stop-btn stop-btn-holding" : "stop-btn",
          title: t("chat.stop.hardHint"),
        } as object)}
        style={({ pressed }) => [
          {
            width: 48,
            height: 48,
            borderRadius: 100,
            // The "soft" tone of the design system (the sidebar "+"): a quiet
            // violet disc that sits next to the mint send instead of a black
            // hole. Holding it fills the ring (holdCss) for the hard stop.
            backgroundColor: c.tint.i.bg,
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            transform: pressed ? [{ scale: 0.94 }] : undefined,
          },
          {
            cursor: "pointer",
            transition: "transform 0.3s cubic-bezier(.16,1,.3,1), background 0.25s",
            touchAction: "none",
          } as any,
        ]}
      >
        <Ph name="stop" size={16} weight="fill" color={c.accent} />
      </Pressable>
      {/* Offscreen (not display:none) so screen readers pick it up via aria-describedby. */}
      <span
        id="stop-btn-hint"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          opacity: 0,
          pointerEvents: "none",
        }}
      >
        {t("chat.stop.hardHint")}
      </span>
      <HardCancelModal
        open={modalOpen}
        hasIrreversibleToolInFlight={hasIrreversibleToolInFlight}
        irreversibleToolName={irreversibleToolName}
        onConfirm={handleHardConfirm}
        onCancel={() => setModalOpen(false)}
      />
    </>
  )
}
