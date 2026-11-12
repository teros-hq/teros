/**
 * The detail window's action bar (TODODH-REQ-3): fixed at the bottom of the
 * window, outside the content's scroll. The primary action is the primary
 * pill at the right end, the secondary actions are outline pills to its left;
 * under 440 px the bar scrolls sideways with the primary first.
 */
import React, { useCallback, useState } from "react"
import { useTranslation } from "react-i18next"
import { type LayoutChangeEvent, ScrollView, View, type ViewStyle } from "react-native"
import type { NodeDetail, NodeState } from "../model/types"
import { Btn } from "../ui/kit"
import { web } from "../ui/todoFx"
import { useTd } from "../ui/tokens"

/** What a bar action does: a transition, the agent's manual start, or the block-reason flow. */
export type BarRun = { kind: "state"; to: NodeState } | { kind: "start" } | { kind: "block" }

export interface BarAction {
  /** `todo.verb.<key>` */
  verb: string
  run: BarRun
}

/** Under this width the bar scrolls sideways, primary first. */
export const BAR_NARROW = 440

const st = (from: NodeState, to: NodeState): BarAction => ({ verb: `${from}_${to}`, run: { kind: "state", to } })

/**
 * @spec TODODH-REQ-3 The bar's actions per state: one primary (or none) and the
 * secondaries in order. Groups have no bar; while the send-back note box is
 * open (TODOAP-REQ-21) review shows neither Accept nor Send back.
 * Every open state offers "Cancel task" (Pablo, 2026-10-30); a cancelled task
 * offers "Reopen" (→ pending).
 */
export function barActions(
  node: Pick<NodeDetail, "kind" | "state" | "assignee" | "channelId">,
  sendingBack = false,
): { primary: BarAction | null; secondary: BarAction[] } | null {
  if (node.kind === "group") return null
  const state = (node.state ?? "pending") as NodeState
  // The cancel pill: offered from every open state, never from done.
  // Verb key follows the `<from>_<to>` convention (planning_cancelled, ...) so it
  // resolves against the todo.verb.* keys shipped with the cancelled feature.
  const cancel: BarAction = { verb: `${state}_cancelled`, run: { kind: "state", to: "cancelled" } }
  switch (state) {
    case "planning":
      return { primary: st("planning", "pending"), secondary: [cancel] }
    case "pending":
      return {
        primary: node.assignee?.kind === "agent" ? { verb: "pending_working", run: { kind: "start" } } : st("pending", "working"),
        secondary: [st("pending", "done"), st("pending", "planning"), cancel],
      }
    case "working":
      return {
        primary: st("working", "review"),
        secondary: [
          st("working", "done"),
          { verb: "working_blocked", run: { kind: "block" } },
          st("working", "pending"),
          // TODOAP-REQ-13's manual start: an agent task that has no conversation yet.
          ...(node.assignee?.kind === "agent" && !node.channelId ? [{ verb: "pending_working", run: { kind: "start" } } as BarAction] : []),
          cancel,
        ],
      }
    case "blocked":
      return { primary: null, secondary: [st("blocked", "planning"), cancel] }
    case "review":
      // While the send-back note box is open (TODOAP-REQ-21) the bar steps
      // aside entirely — no actions, not even the cancel pill, so it never
      // competes with the note box's own Cancel button.
      return sendingBack
        ? { primary: null, secondary: [] }
        : { primary: st("review", "done"), secondary: [st("review", "working"), cancel] }
    case "done":
      return { primary: st("done", "working"), secondary: [] }
    case "cancelled":
      return { primary: st("cancelled", "pending"), secondary: [] }
  }
}

/**
 * @spec TODODH-REQ-3 The bar fixed at the bottom of the detail window (sheet
 * background, hairline on top, 10 px vertical padding, safe-area aware).
 * Renders nothing for a group or when the state has no action.
 */
export function ActionBar({
  node,
  sendingBack,
  onRun,
}: {
  node: Pick<NodeDetail, "kind" | "state" | "assignee" | "channelId">
  sendingBack: boolean
  onRun: (run: BarRun) => void
}) {
  const td = useTd()
  const { t } = useTranslation()
  const [width, setWidth] = useState(0)
  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width), [])
  const acts = barActions(node, sendingBack)
  if (!acts || (!acts.primary && !acts.secondary.length)) return null
  const narrow = width > 0 && width < BAR_NARROW

  const primary = acts.primary ? (
    <Btn key="primary" tone="pri" onPress={() => onRun(acts.primary!.run)}>
      {t(`todo.verb.${acts.primary.verb}`)}
    </Btn>
  ) : null
  const secondary = acts.secondary.map((a) => (
    <Btn key={a.verb} tone="out" onPress={() => onRun(a.run)}>
      {t(`todo.verb.${a.verb}`)}
    </Btn>
  ))
  const pad = narrow ? 16 : 26

  return (
    <View
      testID="todo-action-bar"
      accessibilityLabel={t("todo.a11y.actions")}
      {...({ role: "toolbar" } as Record<string, unknown>)}
      onLayout={onLayout}
      style={[
        { flexShrink: 0, backgroundColor: td.sheet, borderTopWidth: 1, borderTopColor: td.borderStrong, paddingTop: 10, paddingBottom: 10 },
        web({ paddingBottom: "calc(10px + env(safe-area-inset-bottom, 0px))" }) as ViewStyle,
      ]}
    >
      {narrow ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ flexDirection: "row", gap: 6, paddingHorizontal: pad }}
        >
          {primary}
          {secondary}
        </ScrollView>
      ) : (
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 6, paddingHorizontal: pad }}>
          {secondary}
          {primary}
        </View>
      )}
    </View>
  )
}
