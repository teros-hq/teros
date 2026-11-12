/**
 * Segmented state bar + legend ("2 pending · 3 in progress …"), used by the day
 * summary and group detail.
 *
 * With `tasks` (day view) and fewer than 50 of them, each state group renders as
 * ONE pill — rounded only at the outer ends — with a thin 1px cut in the page
 * background between the tasks inside it (docs/design/20261031-day-statebar-segmented.html).
 * At ≥ 50 tasks the same pill goes solid: at that density the cuts would eat the
 * segments. Without `tasks` (group detail) the classic per-state bar is kept.
 * Purely visual — no tooltip, no press.
 */
import React from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { STATE_ORDER } from "../model/states"
import type { DayTask, NodeState } from "../model/types"
import { Dot, Tx } from "./kit"
import { tdx } from "./todoFx"
import { useTd } from "./tokens"

/** Below this many day tasks the per-task cuts are drawn; at or above, solid pills.
 *  At that density a 1px cut per task dominates the segment width (Pablo, 31-oct). */
const SEGMENTED_MAX = 50

export function StateBar({ counts, tasks }: { counts: Record<NodeState, number>; tasks?: DayTask[] }) {
  const td = useTd()
  const { t } = useTranslation()
  const present = STATE_ORDER.filter((s) => counts[s] > 0)
  const segmented = !!tasks && tasks.length > 0 && tasks.length < SEGMENTED_MAX
  const perState = segmented
    ? STATE_ORDER.reduce((acc, s) => {
        acc[s] = tasks!.filter((x) => x.state === s)
        return acc
      }, {} as Record<NodeState, DayTask[]>)
    : null
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", gap: 3, height: 6, borderRadius: 3, overflow: "hidden" }} {...tdx("sbar")}>
        {present.map((s) =>
          segmented && perState![s].length > 0 ? (
            // One pill per state: rounding lives here (outer ends only) — the
            // segments inside must stay square so the pill reads as one bar.
            <View
              key={s}
              accessibilityLabel={`${t(`todo.state.${s}`)}: ${counts[s]}`}
              style={{ flex: counts[s], minWidth: 6, flexDirection: "row", borderRadius: 3, overflow: "hidden", backgroundColor: td.st[s] }}
              {...tdx("sgrp")}
            >
              {perState![s].map((task, i) => (
                // Flat segment per task, cut from the next by a 1px right border
                // in the page background — the last one carries no cut.
                <View
                  key={task.nodeId}
                  style={{
                    flex: 1,
                    minWidth: 1,
                    borderRightWidth: i < perState![s].length - 1 ? 1 : 0,
                    borderTopWidth: 0,
                    borderBottomWidth: 0,
                    borderLeftWidth: 0,
                    borderColor: td.sheet,
                  }}
                />
              ))}
            </View>
          ) : (
            <View
              key={s}
              accessibilityLabel={`${t(`todo.state.${s}`)}: ${counts[s]}`}
              style={{ flex: counts[s], minWidth: 6, borderRadius: 3, backgroundColor: td.st[s] }}
            />
          ),
        )}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 12, rowGap: 4 }}>
        {present.map((s) => (
          <View key={s} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <Dot state={s} size={6} still />
            <Tx f="mono" s={10.5} lh={16} c={td.txs}>
              {t(`todo.legend.${s}`, { count: counts[s] })}
            </Tx>
          </View>
        ))}
      </View>
    </View>
  )
}
