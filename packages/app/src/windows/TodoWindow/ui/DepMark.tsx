/**
 * The dependency mark (TODODEP - Option A "ver y respetar", Pablo 2-nov):
 * the board's exact visual language - the semaforo dot (green/orange/red,
 * amber + warning for circular) plus a lock while the task waits. Reusable
 * on purpose: the props are (blockStatus, waiting, label) so the board can
 * adopt the same component later (closing its own semaforo is a separate
 * task, tn_ek6D5lW64bTaJQt - NOT part of TODODEP).
 *
 * ZERO NOISE RULE: nothing renders when the task has no dependencies - the
 * rows look exactly as before. The mark shows only while there is something
 * to say (a pending dependency); an all-released task shows the quiet green
 * dot without the lock, so "has deps, all done" stays visible but calm.
 *
 * Hover/tap reveals the reason: "Espera a: X (estado)" - the visible wait
 * where today there would be unexplained silence.
 */
import React, { useState } from "react"
import { Platform, Pressable, View, type ViewStyle } from "react-native"
import { Ph } from "../../../components/ui/ds"
import type { DependencyRef } from "../model/types"
import { Tx } from "./kit"
import { web } from "./todoFx"
import { useTd } from "./tokens"

/** Board parity: BLOCK_STATUS_CONFIG colours (BoardWindow/board-utils.ts). */
export const DEP_COLORS = {
  green: "#22C55E",
  orange: "#F97316",
  red: "#EF4444",
  circular: "#F59E0B",
} as const

/**
 * The semaforo dot + lock. `blockers` powers the hover/tap reason; the caller
 * passes the already-translated prefix ("Espera a:").
 */
export function DepMark({
  status,
  waiting,
  blockers,
  reasonPrefix,
  size = 8,
}: {
  status: "green" | "orange" | "red" | "circular"
  /** True while some dependency is unresolved - shows the lock. */
  waiting: boolean
  /** The direct blockers, for the hover/tap reason. */
  blockers?: DependencyRef[]
  reasonPrefix?: string
  size?: number
}) {
  const td = useTd()
  const [open, setOpen] = useState(false)
  const color = DEP_COLORS[status]
  // Only unresolved blockers carry the reason.
  const pending = (blockers ?? []).filter((b) => b.state !== "done" && b.state !== "cancelled")
  const reason =
    pending.length > 0 && reasonPrefix
      ? `${reasonPrefix} ${pending.map((b) => `${b.text}${b.state ? ` (${b.state})` : ""}`).join(" · ")}`
      : null

  const dot = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 3, flexShrink: 0 }}>
      <View
        testID={"todo-dep-dot"}
        accessibilityLabel={reason ?? undefined}
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
          flexShrink: 0,
        }}
      />
      {waiting ? (
        <Ph name={status === "circular" ? "warning" : "lock-key"} size={10} color={color} />
      ) : null}
    </View>
  )

  if (!reason) return dot
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={reason}
      onHoverIn={() => setOpen(true)}
      onHoverOut={() => setOpen(false)}
      onPress={() => setOpen((v) => !v)}
      style={[{ flexShrink: 0 }, web({ cursor: "help" }) as ViewStyle]}
    >
      {dot}
      {open ? (
        <View
          testID="todo-dep-reason"
          style={[
            {
              position: "absolute",
              top: "100%",
              left: 0,
              marginTop: 6,
              zIndex: 60,
              backgroundColor: td.card,
              borderRadius: 10,
              paddingHorizontal: 10,
              paddingVertical: 7,
              maxWidth: 280,
              boxShadow: `${td.elevRaised}, 0 0 0 1px ${td.borderStrong}`,
            },
            web({ whiteSpace: "normal" }) as ViewStyle,
          ]}
        >
          <Tx s={11.5} lh={15} c={td.text}>
            {reason}
          </Tx>
        </View>
      ) : null}
    </Pressable>
  )
}

/**
 * The props every row needs to draw the mark: nothing when the task has no
 * dependencies (the ZERO NOISE rule lives here - rows without deps pass
 * `hasDeps: false` and render nothing).
 */
export interface DepMarkProps {
  dependencies?: string[]
  blockStatus?: "green" | "orange" | "red" | "circular"
  blockers?: DependencyRef[]
}

/** True when the task carries dependencies (the mark's gate). */
export const hasDependencies = (p: DepMarkProps): boolean => (p.dependencies?.length ?? 0) > 0

/** True while some dependency is unresolved (the lock's gate). */
export const isWaitingOnDeps = (p: DepMarkProps): boolean =>
  hasDependencies(p) && p.blockStatus !== "green"
