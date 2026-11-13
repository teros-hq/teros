import { useEffect, useRef } from "react"
import { View } from "react-native"
import { useWindowChromeStore, useWindowClosing } from "../../store/windowChromeStore"
import { useColors } from "../mca/primitives/useColors"
import { Btn, T } from "../ui/ds"
import { answerClose } from "./windowClose"

export function WindowCloseConfirm({ windowId }: { windowId: string }) {
  const c = useColors()
  const question = useWindowClosing(windowId)
  const bar = useRef<View | null>(null)
  const asking = question !== null
  useEffect(() => {
    if (!asking || typeof document === "undefined") return
    const node = bar.current as unknown as HTMLElement | null
    node
      ?.querySelector<HTMLElement>(`[data-testid="window-close-confirm-${windowId}-keep"]`)
      ?.focus?.()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") answerClose(windowId, "keep")
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [asking, windowId])
  useEffect(() => () => useWindowChromeStore.getState().setClosing(windowId, null), [windowId])
  if (!question) return null
  return (
    <View
      ref={bar}
      testID={`window-close-confirm-${windowId}`}
      accessibilityRole="alert"
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 12,
        paddingVertical: 8,
        backgroundColor: c.bgStep,
        borderBottomWidth: 1,
        borderBottomColor: c.border,
      }}
    >
      <T step="sm" style={{ color: c.text, flex: 1, minWidth: 220 }}>
        {question.message}
      </T>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginLeft: "auto" }}>
        <Btn
          size="sm"
          variant="danger"
          onPress={() => answerClose(windowId, "confirm")}
          testID={`window-close-confirm-${windowId}-ok`}
        >
          {question.confirmLabel}
        </Btn>
        <Btn
          size="sm"
          variant="primary"
          onPress={() => answerClose(windowId, "keep")}
          testID={`window-close-confirm-${windowId}-keep`}
        >
          {question.keepLabel}
        </Btn>
      </View>
    </View>
  )
}
