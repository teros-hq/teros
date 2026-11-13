import { View } from "react-native"
import type { TabState } from "../../hooks/useTabState"
import type { WindowStatus } from "../../store/windowTabMetaStore"
import { colors as semanticColors } from "../mca/primitives/colors"
import { useColors } from "../mca/primitives/useColors"
import { TerosLoading } from "../TerosLoading"
import { Dot, Ph, WorkingDot } from "../ui/ds"
import { buildTabColors } from "./tabColors"
import { ChromeIcon } from "./WindowChrome"

export function useStatusColors() {
  const c = useColors()
  const TC = buildTabColors(c)
  return {
    working: TC.spinnerAccent,
    needsYou: TC.redDot,
    finished: semanticColors.green,
    unread: TC.blueDot,
  }
}

function Mark({ kind, size }: { kind: WindowStatus; size: number }) {
  const colors = useStatusColors()
  return (
    <View
      testID={`window-status-${kind}`}
      style={{ alignItems: "center", justifyContent: "center" }}
    >
      {kind === "working" ? (
        <TerosLoading size={Math.round(size * 1.75)} color={colors.working} />
      ) : (
        <Dot size={size} color={kind === "needs-you" ? colors.needsYou : colors.finished} />
      )}
    </View>
  )
}

export function WindowStatusMark({
  status,
  size = 8,
}: {
  status: WindowStatus | null | undefined
  size?: number
}) {
  return status ? <Mark kind={status} size={size} /> : null
}

export function TabStatusSlot({
  state,
  glyph,
  box = 16,
  iconSize = 14,
}: {
  state: TabState
  glyph: string
  box?: number
  iconSize?: number
}) {
  const colors = useStatusColors()
  const { Icon, meta, definition } = state
  const phIcon = meta?.phIcon ?? (definition?.phIcon as string | undefined)
  const dot = Math.round(box / 2)
  const override = state.chrome?.icon
  return (
    <View
      style={{
        width: box,
        height: box,
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {state.showSpinner && <Mark kind="working" size={dot} />}
      {state.showRedDot && <Mark kind="needs-you" size={dot} />}
      {state.showDoneDot && <Mark kind="finished" size={dot} />}
      {state.showBlueDot && <Dot size={dot} color={colors.unread} />}
      {state.showIcon && override ? (
        <ChromeIcon icon={override} size={override.face ? box : iconSize} glyph={glyph} />
      ) : null}
      {state.showIcon &&
        !override &&
        (meta?.spinner && meta.dotColor ? (
          <WorkingDot size={dot} color={meta.dotColor} />
        ) : meta?.dotColor ? (
          <View
            style={{
              width: dot,
              height: dot,
              borderRadius: dot / 2,
              backgroundColor: meta.dotHollow ? "transparent" : meta.dotColor,
              borderWidth: meta.dotHollow ? 1.5 : 0,
              borderColor: meta.dotColor,
            }}
          />
        ) : phIcon ? (
          <Ph name={phIcon} size={iconSize} color={glyph} />
        ) : Icon ? (
          <Icon size={iconSize} color={glyph} />
        ) : null)}
    </View>
  )
}
