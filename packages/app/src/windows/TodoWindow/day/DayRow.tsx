/**
 * A row of the day view: same treatment as the tree (handle, dot, progress
 * fill, purple in review) plus the time in violet mono and the breadcrumb.
 * Done rows keep a transparent background — no full green fill — with the
 * solid green dot, dimmed struck-through text (Pablo, 2026-10-24). `day` rows
 * take × on hover (off the day); `late` and `tray` rows carry a "Today"/"Here"
 * pill. Done rows in the day's Completed fold pass `frozen` — no drag handle:
 * they are not reorderable, the fold owns their place at the bottom.
 */
import React, { memo } from "react"
import { useTranslation } from "react-i18next"
import { Platform, Pressable, type TextStyle, View, type ViewStyle } from "react-native"
import { Ph } from "../../../components/ui/ds"
import type { Person } from "../data/usePeople"
import { ConversationIcon } from "../autoplay/Conversation"
import { TerminalIcon } from "../autoplay/Terminal"
import { PersonAvatar } from "../node/AssignChip"
import type { DayTask } from "../model/types"
import { DepMark, hasDependencies, isWaitingOnDeps } from "../ui/DepMark"
import { Dot, Tx } from "../ui/kit"
import { tdx, useRowHover, web } from "../ui/todoFx"
import { progressFill } from "../ui/rowFill"
import { useTd } from "../ui/tokens"

interface Props {
  task: DayTask
  kind: "day" | "late" | "tray"
  time?: string | null
  right: string
  actionLabel: string
  selected: boolean
  /** Another row is selected: dim this title (spotlight). */
  dimmed: boolean
  flashing: boolean
  phone: boolean
  hideCrumb?: boolean
  assignee?: Person
  /** No drag handle (done rows in the Completed fold): the fold owns their place. */
  frozen?: boolean
  onPress: (id: string) => void
  onAction: () => void
  /** Opens the task's linked conversation (TODOAP-REQ-13). */
  onOpenConversation: (channelId: string) => void
  /** Opens the task's runner terminal (CCR-REQ-8) — the terminal wins over the conversation. */
  onOpenTerminal: (nodeId: string) => void
}

export const DayRow = memo(function DayRow({
  task,
  kind,
  time,
  right,
  actionLabel,
  selected,
  dimmed,
  flashing,
  phone,
  hideCrumb,
  assignee,
  frozen,
  onPress,
  onAction,
  onOpenConversation,
  onOpenTerminal,
}: Props) {
  const td = useTd()
  const { t } = useTranslation()
  const p = Math.max(0, Math.min(100, task.progress ?? 0))
  const full = p >= 100
  const review = task.state === "review"
  const working = task.state === "working"
  const done = task.state === "done"
  // cancelled: done's dimming in grey (Pablo, 2026-10-30).
  const quiet = done || task.state === "cancelled"
  const pill = kind !== "day"
  const rowRef = useRowHover()
  return (
    <Pressable
      ref={rowRef as any}
      onPress={() => onPress(task.nodeId)}
      accessibilityLabel={`${task.text} · ${t(`todo.state.${task.state}`)}`}
      {...({ role: "listitem", tabIndex: selected ? 0 : -1 } as Record<string, unknown>)}
      {...tdx(`row${flashing ? " flash" : ""}`, { tdid: task.nodeId, kind })}
      style={({ hovered }: any) => [
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          height: phone ? 40 : 32,
          paddingLeft: 4,
          paddingRight: pill ? 72 : 60,
          borderRadius: 9,
          position: "relative",
          backgroundColor: hovered ? td.wash2 : "transparent",
        },
        web({ cursor: "pointer", userSelect: "none", isolation: "isolate" }) as ViewStyle,
      ]}
    >
      {({ hovered }: any) => (
        <>
          {p > 0 && !done && !full ? (
            <View
              {...tdx(`pfill${full ? " full" : ""}`)}
              pointerEvents="none"
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                bottom: 0,
                width: full ? "100%" : `${p}%`,
                backgroundColor: progressFill(td, task.state),
                borderRadius: 9,
                borderTopRightRadius: full ? 9 : 0,
                borderBottomRightRadius: full ? 9 : 0,
                zIndex: -1,
              }}
            />
          ) : null}
          {frozen ? (
            // Alignment spacer: the handle's width without the handle — frozen
            // rows are not draggable.
            <View style={{ width: 10, marginRight: 0 }} />
          ) : (
            <View
              {...tdx("hd")}
              style={{
                width: 14,
                height: 24,
                marginRight: -4,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 5,
                backgroundColor: selected ? td.st[task.state] : "transparent",
                opacity: selected ? 1 : Platform.OS !== "web" ? 0.6 : hovered ? 0.75 : 0.32,
              }}
            >
              <Ph name="dots-six-vertical" size={13} color={selected ? "#FFFFFF" : td.text3} />
            </View>
          )}
          <Dot state={task.state} running={task.running} />
          {/* TODODEP: the semaforo + lock, ONLY with dependencies (zero noise
              otherwise); hover/tap shows "Espera a: X (estado)". */}
          {hasDependencies(task) ? (
            <DepMark
              status={task.blockStatus ?? "red"}
              waiting={isWaitingOnDeps(task)}
              blockers={task.blockers}
              reasonPrefix={t("todo.dep.waitsOn")}
            />
          ) : null}
          <View style={{ flex: 1, minWidth: 40 }}>
            <Tx
              s={13}
              lh={18}
              c={quiet ? td.doneTx : dimmed ? td.txs : td.text}
              lines={1}
              style={web({ transition: "color .2s" }) as TextStyle}
            >
              {task.text}
            </Tx>
          </View>
          <View style={{ width: 16, height: 16, alignItems: "center", justifyContent: "center" }} accessibilityLabel={assignee?.name}>
            {assignee ? <PersonAvatar person={assignee} size={16} /> : null}
          </View>
          {/* The work-context bubble (CCR-REQ-8): the runner terminal wins over
              the conversation — that is where the live work is. */}
          {task.runner ? (
            <TerminalIcon runner={task.runner} onOpen={() => onOpenTerminal(task.nodeId)} />
          ) : task.channelId ? (
            <ConversationIcon channelId={task.channelId} onOpen={onOpenConversation} />
          ) : null}
          {time ? (
            <Tx f="mono" s={10.5} lh={12} c={td.accent}>
              {time}
            </Tx>
          ) : null}
          {right && !hideCrumb ? (
            <Tx f="mono" s={10} lh={12} c={td.txs} lines={1} style={{ maxWidth: "42%", flexShrink: 1 }}>
              {right}
            </Tx>
          ) : null}
          <View
            style={{
              position: "absolute",
              right: 2,
              top: 0,
              bottom: 0,
              flexDirection: "row",
              alignItems: "center",
              opacity: pill || hovered || selected || Platform.OS !== "web" ? 1 : 0,
            }}
            pointerEvents={pill || hovered || selected || Platform.OS !== "web" ? "auto" : "none"}
          >
            {pill ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={actionLabel}
                {...({ tabIndex: -1 } as Record<string, unknown>)}
                onPress={(e: any) => {
                  e?.stopPropagation?.()
                  onAction()
                }}
                style={({ hovered: h }: any) => [
                  { height: 24, paddingHorizontal: 10, borderRadius: 100, justifyContent: "center", backgroundColor: h ? td.navActive : td.card },
                  web({ cursor: "pointer", boxShadow: `0 0 0 1px ${td.borderStrong}` }) as ViewStyle,
                ]}
              >
                {({ hovered: h }: any) => (
                  <Tx s={11.5} lh={14} c={h ? td.accent : td.text}>
                    {actionLabel}
                  </Tx>
                )}
              </Pressable>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={actionLabel}
                {...({ tabIndex: -1 } as Record<string, unknown>)}
                onPress={(e: any) => {
                  e?.stopPropagation?.()
                  onAction()
                }}
                style={({ hovered: h }: any) => [
                  { width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: h ? td.controlBg : "transparent" },
                  web({ cursor: "pointer" }) as ViewStyle,
                ]}
              >
                <Ph name="x" size={12} color={td.text3} />
              </Pressable>
            )}
          </View>
        </>
      )}
    </Pressable>
  )
})
