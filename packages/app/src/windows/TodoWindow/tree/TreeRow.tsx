/**
 * One tree row (`.nr` in the mock): reserved-space drag handle, caret, 8 px
 * state dot (tasks), title, blocked/review counters, done/total, and the
 * focus (eye) + add actions on hover/selection. The row box starts at its own
 * indent (margin-left = depth × 16), so fills begin at the row's handle.
 * Selection paints no background (it would mix with the state fills): the
 * handle becomes a pill in the task's state colour (violet for groups) with
 * white dots, and every other title dims (spotlight); nothing moves. The progress fill sits behind the row: blurred edge
 * while open, crisp at 100 %, purple in review. Done rows keep a transparent
 * background — no fill — with dimmed struck-through text (Pablo, 2026-10-24);
 * the mint sweep still plays when it turns done.
 */
import React, { memo, useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { Platform, Pressable, type TextStyle, View, type ViewStyle } from "react-native"
import { Ph } from "../../../components/ui/ds"
import type { Person } from "../data/usePeople"
import { ConversationIcon } from "../autoplay/Conversation"
import { TerminalIcon } from "../autoplay/Terminal"
import { PersonAvatar } from "../node/AssignChip"
import type { VisibleRow } from "../model/tree"
import { DepMark, hasDependencies, isWaitingOnDeps } from "../ui/DepMark"
import { Dot, Tx } from "../ui/kit"
import { replayAttr, tdx, useRowHover, web } from "../ui/todoFx"
import { progressFill } from "../ui/rowFill"
import { useTd } from "../ui/tokens"

export interface RowCounts {
  blocked: number
  review: number
  /** Groups: open tasks below. Tasks: done/total of child tasks. */
  right: string | null
}

interface Props {
  row: VisibleRow
  counts: RowCounts
  selected: boolean
  focused: boolean
  celebrating: boolean
  /** Another row is selected: dim this title (spotlight). */
  dimmed: boolean
  flashing: boolean
  phone: boolean
  onPress: (id: string) => void
  onToggle: (id: string) => void
  onFocus: (id: string) => void
  onAdd: (id: string) => void
  /** The task's assignee (16 px avatar in a reserved slot), if any. */
  assignee?: Person
  /** A group row's "+" shows the New task / New group menu (rendered by the tree). */
  addMenu?: React.ReactNode
  /** Opens the task's linked conversation (TODOAP-REQ-13). */
  onOpenConversation: (channelId: string) => void
  /** Opens the task's runner terminal (CCR-REQ-8) — the terminal wins over the conversation. */
  onOpenTerminal: (nodeId: string) => void
  /** Click feedback: the handle beats once per click (`n` bumps); `strong` when the node was already open. */
  beat?: { n: number; strong: boolean }
  /** Archive / unarchive this node (set-archived); absent hides the action. */
  onArchive?: (id: string, archived: boolean) => void
}

export const TreeRow = memo(function TreeRow({
  row,
  counts,
  selected,
  focused,
  celebrating,
  dimmed,
  flashing,
  phone,
  onPress,
  onToggle,
  onFocus,
  onAdd,
  addMenu,
  assignee,
  onOpenConversation,
  onOpenTerminal,
  beat,
  onArchive,
}: Props) {
  const td = useTd()
  const { t } = useTranslation()
  const n = row.node
  const isTask = n.kind !== "group"
  const isRoot = !isTask && row.depth === 0
  const p = isTask ? Math.max(0, Math.min(100, n.progress ?? 0)) : 0
  const full = p >= 100
  const review = n.state === "review"
  const working = n.state === "working"
  const done = n.state === "done"
  // cancelled gets done's exact dimming treatment, in grey (Pablo, 2026-10-30):
  // no progress fill, quiet text, transparent background.
  const cancelled = n.state === "cancelled"
  const quiet = done || cancelled
  // Archived rows: reduced opacity + archive badge + state chip (settings
  // zone); fully readable — clicking still opens the normal detail window.
  const archived = !!n.archived
  const depth = Math.min(row.depth, 7)
  const h = phone ? 40 : isRoot ? (phone ? 42 : 36) : 32
  const stateLabel = isTask && n.state ? t(`todo.state.${n.state}`) : t("todo.row.group")
  const a11y = `${n.text} · ${stateLabel}${isTask && p > 0 && p < 100 ? ` · ${p}%` : ""}`
  const fx = ["row", celebrating ? "cele" : "", flashing ? "flash" : ""].filter(Boolean).join(" ")

  const rowRef = useRowHover()
  const hdRef = useRef<any>(null)
  useEffect(() => {
    if (beat) replayAttr(hdRef.current, "data-beat", beat.strong ? "2" : "1")
  }, [beat])
  return (
    <Pressable
      ref={rowRef as any}
      onPress={() => onPress(n.nodeId)}
      accessibilityLabel={a11y}
      {...({
        role: "treeitem",
        "aria-level": row.depth + 1,
        "aria-selected": selected,
        "aria-expanded": row.hasKids ? !row.closed : undefined,
        tabIndex: selected ? 0 : -1,
      } as Record<string, unknown>)}
      {...tdx(fx, { tdid: n.nodeId, depth: String(depth) })}
      style={({ hovered }: any) => [
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          height: h,
          marginTop: isRoot ? 6 : 0,
          marginLeft: depth * 16,
          paddingLeft: 4,
          paddingRight: 60,
          borderRadius: 9,
          position: "relative",
          zIndex: addMenu ? 30 : undefined,
          backgroundColor: hovered ? td.wash2 : "transparent",
          overflow: Platform.OS === "web" ? undefined : "hidden",
          opacity: archived ? 0.55 : 1,
        },
        web({ cursor: "pointer", userSelect: "none", isolation: "isolate" }) as ViewStyle,
      ]}
    >
      {({ hovered }: any) => (
        <>
          {p > 0 && !quiet && !full ? (
            <View
              {...tdx(`pfill${full ? " full" : ""}`)}
              pointerEvents="none"
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                bottom: 0,
                width: full ? "100%" : `${p}%`,
                backgroundColor: progressFill(td, n.state),
                borderTopLeftRadius: 9,
                borderBottomLeftRadius: 9,
                borderTopRightRadius: full ? 9 : 0,
                borderBottomRightRadius: full ? 9 : 0,
                zIndex: -1,
              }}
            />
          ) : null}
          <View
            {...tdx("sweep")}
            pointerEvents="none"
            style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, borderRadius: 9, zIndex: -1 }}
          />
          <View
            ref={hdRef}
            {...tdx("hd")}
            accessibilityLabel={t("todo.row.drag")}
            style={{
              width: 14,
              height: 24,
              marginRight: -4,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 5,
              backgroundColor: selected ? (isTask && n.state ? td.st[n.state] : td.accent) : "transparent",
              opacity: selected ? 1 : Platform.OS !== "web" ? 0.6 : hovered ? 0.75 : 0.32,
            }}
          >
            <Ph name="dots-six-vertical" size={13} color={selected ? "#FFFFFF" : td.text3} />
          </View>
          {row.hasKids ? (
            <Pressable
              accessibilityLabel={row.closed ? t("todo.row.expand") : t("todo.row.collapse")}
              onPress={(e: any) => {
                e?.stopPropagation?.()
                onToggle(n.nodeId)
              }}
              {...({ tabIndex: -1 } as Record<string, unknown>)}
              style={[
                {
                  width: 22,
                  height: h,
                  marginLeft: -2,
                  marginRight: -6,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 6,
                },
                web({ cursor: "pointer" }) as ViewStyle,
              ]}
            >
              <View style={web({ transform: row.closed ? "rotate(-90deg)" : "none", transition: "transform .2s cubic-bezier(.16,1,.3,1)" }) as ViewStyle}>
                <Ph name="caret-down" size={10} color={td.text3} />
              </View>
            </Pressable>
          ) : (
            <View style={{ width: 22, marginLeft: -2, marginRight: -6 }} />
          )}
          {isTask ? <Dot state={n.state} running={n.running} /> : null}
          {/* TODODEP: the semaforo + lock, ONLY with dependencies (zero noise
              otherwise); hover/tap shows "Espera a: X (estado)". */}
          {isTask && hasDependencies(n) ? (
            <DepMark
              status={n.blockStatus ?? "red"}
              waiting={isWaitingOnDeps(n)}
              blockers={n.blockers}
              reasonPrefix={t("todo.dep.waitsOn")}
            />
          ) : null}
          <View style={{ flex: 1, minWidth: 40 }}>
            {isRoot ? (
              <Tx
                f="serif"
                s={16}
                lh={20}
                c={quiet ? td.doneTx : dimmed ? td.txs : td.text}
                lines={1}
                ls={0.08}
                style={web({ transition: "color .2s" }) as TextStyle}
              >
                {n.text}
              </Tx>
            ) : !isTask ? (
              <Tx s={10.5} lh={14} c={selected ? td.text : td.txs} ls={1.5} upper lines={1} style={web({ transition: "color .2s" }) as TextStyle}>
                {n.text}
              </Tx>
            ) : (
              <Tx
                s={13}
                lh={18}
                c={quiet ? td.doneTx : dimmed ? td.txs : td.text}
                lines={1}
                style={web({ transition: "color .2s" }) as TextStyle}
              >
                {n.text}
              </Tx>
            )}
          </View>
          {archived ? (
            <View
              accessibilityLabel={t("todo.row.archivedBadge")}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                paddingHorizontal: 5,
                borderRadius: 5,
                backgroundColor: td.wash2,
                flexShrink: 0,
              }}
            >
              <Ph name="archive" size={10} color={td.txs} />
              {isTask && n.state ? (
                <Tx f="mono" s={9} lh={14} c={td.txs}>
                  {t(`todo.state.${n.state}`)}
                </Tx>
              ) : null}
            </View>
          ) : null}
          {isTask ? (
            <View style={{ width: 16, height: 16, alignItems: "center", justifyContent: "center" }} accessibilityLabel={assignee?.name}>
              {assignee ? <PersonAvatar person={assignee} size={16} /> : null}
            </View>
          ) : null}
          {/* The work-context bubble (CCR-REQ-8): the runner terminal wins over
              the conversation — that is where the live work is. */}
          {isTask && n.runner ? (
            <TerminalIcon runner={n.runner} onOpen={() => onOpenTerminal(n.nodeId)} />
          ) : isTask && n.channelId ? (
            <ConversationIcon channelId={n.channelId} onOpen={onOpenConversation} />
          ) : null}
          {counts.blocked > 0 ? (
            <Tx f="mono" s={9.5} lh={12} c={td.rTx}>
              {t("todo.kin.blocked", { count: counts.blocked })}
            </Tx>
          ) : null}
          {counts.review > 0 ? (
            <Tx f="mono" s={9.5} lh={12} c={td.accent}>
              {t("todo.kin.review", { count: counts.review })}
            </Tx>
          ) : null}
          {counts.right ? (
            <Tx f="mono" s={10} lh={12} c={td.txs}>
              {counts.right}
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
              opacity: hovered || selected || addMenu || Platform.OS !== "web" ? 1 : 0,
              zIndex: addMenu ? 40 : undefined,
            }}
            pointerEvents={hovered || selected || addMenu || Platform.OS !== "web" ? "auto" : "none"}
          >
            <RowAction
              icon={focused ? "eye-slash" : "eye"}
              on={focused}
              label={focused ? t("todo.row.exitFocus", { title: n.text }) : t("todo.row.focus", { title: n.text })}
              onPress={() => onFocus(n.nodeId)}
            />
            {onArchive ? (
              <RowAction
                icon="archive"
                label={archived ? t("todo.row.unarchive", { title: n.text }) : t("todo.row.archive", { title: n.text })}
                on={archived}
                onPress={() => onArchive(n.nodeId, !archived)}
              />
            ) : null}
            <View style={{ position: "relative" }}>
              <RowAction icon="plus" label={t("todo.row.add", { title: n.text })} onPress={() => onAdd(n.nodeId)} />
              {addMenu}
            </View>
          </View>
        </>
      )}
    </Pressable>
  )
})

function RowAction({ icon, label, onPress, on }: { icon: string; label: string; onPress: () => void; on?: boolean }) {
  const td = useTd()
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      {...({ tabIndex: -1 } as Record<string, unknown>)}
      onPress={(e: any) => {
        e?.stopPropagation?.()
        onPress()
      }}
      style={({ hovered }: any) => [
        {
          width: 28,
          height: 28,
          borderRadius: 14,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: hovered ? td.controlBg : "transparent",
        },
        web({ cursor: "pointer" }) as ViewStyle,
      ]}
    >
      {({ hovered }: any) => <Ph name={icon} size={icon === "plus" ? 12 : 15} color={on ? td.accent : hovered ? td.text : td.text3} />}
    </Pressable>
  )
}
