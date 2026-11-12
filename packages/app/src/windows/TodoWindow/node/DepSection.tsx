/**
 * The dependency sections of the task detail (TODODEP - Option A, Pablo
 * 2-nov): "Bloqueada por" (the tasks it waits on, each clickable, one-tap
 * remove) and "Bloquea a" (the inverse - the tasks waiting on it, read-only:
 * removing a wait is done from the waiting task), plus the searcher that
 * adds a blocker (any task of the workspace, any group - never
 * cross-workspace). The searcher is the AssignChip pattern (Field + filtered
 * list); every row carries the blocker's state dot so the wait reads at a
 * glance.
 *
 * ZERO NOISE RULE: the whole block renders only when the task HAS
 * dependencies or dependents - a task without either looks exactly as
 * before. The "add" link lives in the "Bloqueada por" header, so adding the
 * first dependency is one click away without painting chrome on every task.
 */
import React, { useMemo, useState } from "react"
import { Platform, Pressable, ScrollView, View, type ViewStyle } from "react-native"
import { Ph } from "../../../components/ui/ds"
import type { DependencyRef, TreeNode } from "../model/types"
import { DEP_COLORS, isWaitingOnDeps } from "../ui/DepMark"
import { Dot, Field, MenuHead, Tx } from "../ui/kit"
import { web } from "../ui/todoFx"
import { useTd } from "../ui/tokens"

/** One dependency row: state dot + title (clickable) + remove (own blockers only). */
function DepRow({
  dep,
  onOpen,
  onRemove,
  removeLabel,
}: {
  dep: DependencyRef
  onOpen: (nodeId: string) => void
  onRemove?: (nodeId: string) => void
  removeLabel?: string
}) {
  const td = useTd()
  const released = dep.state === "done" || dep.state === "cancelled"
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={dep.text}
      onPress={() => onOpen(dep.nodeId)}
      style={({ hovered }: any) => [
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          minHeight: 32,
          paddingHorizontal: 9,
          borderRadius: 9,
          backgroundColor: hovered ? td.wash2 : "transparent",
        },
        web({ cursor: "pointer" }) as ViewStyle,
      ]}
    >
      <Dot state={dep.state} size={7} still />
      <Tx s={12.5} lh={16} c={released ? td.doneTx : td.text} lines={1} style={{ flexShrink: 1 }}>
        {dep.text}
      </Tx>
      <View style={{ flex: 1 }} />
      {onRemove ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={removeLabel ?? "x"}
          onPress={(e: any) => {
            e?.stopPropagation?.()
            onRemove(dep.nodeId)
          }}
          style={({ hovered }: any) => [
            { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: hovered ? td.controlBg : "transparent" },
            web({ cursor: "pointer" }) as ViewStyle,
          ]}
        >
          <Ph name="x" size={11} color={td.text3} />
        </Pressable>
      ) : null}
    </Pressable>
  )
}

/**
 * The searcher: every task of the workspace except the task itself and its
 * current blockers (adding one twice is a server no-op anyway); groups are
 * excluded (a group cannot block). One query field, matches on title.
 */
function DepSearch({
  nodes,
  excludeIds,
  onPick,
  labels,
}: {
  nodes: TreeNode[]
  excludeIds: Set<string>
  onPick: (nodeId: string) => void
  labels: { search: string; tasks: string; noMatch: string }
}) {
  const td = useTd()
  const [q, setQ] = useState("")

  const matches = useMemo(() => {
    const s = q.trim().toLowerCase()
    return nodes
      .filter((n) => n.kind !== "group" && !excludeIds.has(n.nodeId))
      .filter((n) => (s ? n.text.toLowerCase().includes(s) : true))
      .slice(0, 40)
  }, [nodes, excludeIds, q])

  return (
    <View style={{ paddingHorizontal: 6, paddingTop: 6, paddingBottom: 4 }} testID="todo-dep-search">
      <Field
        autoFocus={Platform.OS === "web"}
        value={q}
        onChangeText={setQ}
        placeholder={labels.search}
        accessibilityLabel={labels.search}
      />
      <ScrollView style={{ maxHeight: 240, marginTop: 4 }}>
        {matches.length ? <MenuHead>{labels.tasks}</MenuHead> : null}
        {matches.map((n) => (
          <DepRow key={n.nodeId} dep={{ nodeId: n.nodeId, text: n.text, state: n.state ?? null }} onOpen={onPick} />
        ))}
        {matches.length === 0 ? (
          <Tx s={12.5} lh={18} c={td.txs} style={{ paddingHorizontal: 9, paddingVertical: 8 }}>
            {labels.noMatch}
          </Tx>
        ) : null}
      </ScrollView>
    </View>
  )
}

/**
 * The two sections of the task detail (TODODEP). Rendered between the chips
 * strip and the tabs; zero noise without dependencies AND dependents.
 */
export function DepSections({
  node,
  nodes,
  onOpen,
  onAdd,
  onRemove,
  labels,
}: {
  node: {
    nodeId: string
    dependencies?: string[]
    blockStatus?: "green" | "orange" | "red" | "circular"
    blockers?: DependencyRef[]
    dependents?: DependencyRef[]
  }
  /** The workspace's tree (the searcher's pool). */
  nodes: TreeNode[]
  onOpen: (nodeId: string) => void
  onAdd: (blockerNodeId: string) => void
  onRemove: (blockerNodeId: string) => void
  labels: {
    blockedBy: string
    blocks: string
    add: string
    search: string
    tasks: string
    noMatch: string
    remove: string
    none: string
  }
}) {
  const td = useTd()
  const [adding, setAdding] = useState(false)
  const blockers = node.blockers ?? []
  const dependents = node.dependents ?? []
  const hasDeps = (node.dependencies?.length ?? 0) > 0
  if (!hasDeps && dependents.length === 0) return null

  const waiting = isWaitingOnDeps(node)
  const status = node.blockStatus ?? "red"

  return (
    <View style={{ marginTop: 16, gap: 4 }}>
      {/* Bloqueada por + searcher */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 24, marginBottom: 2 }} testID="todo-dep-section">
        <Tx s={10} lh={12} c={td.txs} ls={1.7} upper>
          {labels.blockedBy}
        </Tx>
        {hasDeps ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: DEP_COLORS[status] }} />
            {waiting ? <Ph name={status === "circular" ? "warning" : "lock-key"} size={11} color={DEP_COLORS[status]} /> : null}
          </View>
        ) : null}
        <View style={{ flex: 1 }} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={labels.add}
          onPress={() => setAdding((v) => !v)}
          style={({ hovered }: any) => [
            { height: 24, paddingHorizontal: 9, borderRadius: 100, justifyContent: "center", backgroundColor: hovered ? td.wash2 : "transparent" },
            web({ cursor: "pointer" }) as ViewStyle,
          ]}
        >
          {({ hovered }: any) => (
            <Tx s={11.5} lh={14} c={hovered ? td.accent : td.text2}>
              {labels.add}
            </Tx>
          )}
        </Pressable>
      </View>
      <View style={{ borderRadius: 12, backgroundColor: td.card, padding: 4 }}>
        {blockers.map((b) => (
          <DepRow key={b.nodeId} dep={b} onOpen={onOpen} onRemove={onRemove} removeLabel={labels.remove} />
        ))}
        {!hasDeps && blockers.length === 0 ? (
          <Tx s={12} lh={16} c={td.txs} style={{ paddingHorizontal: 9, paddingVertical: 6 }}>
            {labels.none}
          </Tx>
        ) : null}
        {adding ? (
          <DepSearch
            nodes={nodes}
            excludeIds={new Set([node.nodeId, ...blockers.map((b) => b.nodeId)])}
            onPick={(id) => {
              setAdding(false)
              onAdd(id)
            }}
            labels={{ search: labels.search, tasks: labels.tasks, noMatch: labels.noMatch }}
          />
        ) : null}
      </View>

      {/* Bloquea a (the inverse, read-only) */}
      {dependents.length > 0 ? (
        <View style={{ marginTop: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 24, marginBottom: 2 }}>
            <Tx s={10} lh={12} c={td.txs} ls={1.7} upper>
              {labels.blocks}
            </Tx>
          </View>
          <View style={{ borderRadius: 12, backgroundColor: td.card, padding: 4 }}>
            {dependents.map((d) => (
              <DepRow key={d.nodeId} dep={d} onOpen={onOpen} />
            ))}
          </View>
        </View>
      ) : null}
    </View>
  )
}
