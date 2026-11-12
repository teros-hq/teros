/**
 * The assignee chip of the detail header's strip, TODODH-REQ-2 (avatar +
 * name, or "Unassigned") and its picker — search, "Assign to me", the workspace's agents
 * and people (photo avatars; agents carry the brand ring), and "Remove
 * assignment". Reference: design-testing/proto-arbol/versions/09-proto-v7.html.
 */
import React, { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Platform, Pressable, ScrollView, View, type ViewStyle } from "react-native"
import { Avatar } from "../../../components/Avatar"
import { Ph } from "../../../components/ui/ds"
import type { Person } from "../data/usePeople"
import type { Assignee } from "../model/types"
import { Field, MenuBox, MenuHead, MenuItem, MenuSep, Tx, useDismiss } from "../ui/kit"
import { web } from "../ui/todoFx"
import { useTd } from "../ui/tokens"
import { StripChip, StripMenu } from "./Chips"

export function PersonAvatar({ person, size = 16 }: { person: Person; size?: number }) {
  return <Avatar name={person.name} imageUrl={person.avatarUrl} size={size} isAgent={person.kind === "agent"} />
}

export function AssignChip({
  assignee,
  people,
  me,
  find,
  onAssign,
}: {
  assignee: Assignee | null
  people: Person[]
  me: string | null
  find: (a: Assignee | null) => Person | undefined
  onAssign: (a: Assignee | null) => void
}) {
  const td = useTd()
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const ref = useRef<View>(null)
  const menuRef = useRef<any>(null)
  useDismiss(open, () => setOpen(false), ref, menuRef)
  const current = find(assignee)
  const name = current?.name ?? (assignee ? assignee.id : null)

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    const list = s ? people.filter((p) => p.name.toLowerCase().includes(s)) : people
    return { agents: list.filter((p) => p.kind === "agent"), humans: list.filter((p) => p.kind === "user") }
  }, [people, q])
  const meIsMember = !!me && people.some((p) => p.kind === "user" && p.id === me)

  useEffect(() => {
    if (!open) setQ("")
  }, [open])

  const pick = (a: Assignee | null) => {
    setOpen(false)
    onAssign(a)
  }
  const isCurrent = (p: Person) => !!assignee && assignee.kind === p.kind && assignee.id === p.id

  return (
    <View ref={ref}>
      <StripChip
        label={`${t("todo.chip.assignee")}: ${name ?? t("todo.assign.none")}`}
        expanded={open}
        onPress={() => setOpen((v) => !v)}
      >
        {current ? <PersonAvatar person={current} size={18} /> : null}
        <Tx s={12.5} lh={16} c={name ? td.text : td.text3} lines={1} style={{ maxWidth: 160 }}>
          {name ?? t("todo.assign.none")}
        </Tx>
        <Ph name="caret-down" size={10} color={td.text3} />
      </StripChip>
      {open ? (
        <StripMenu anchor={ref} menuRef={menuRef}>
          <MenuBox label={t("todo.assign.title")} minWidth={264}>
            <MenuHead>{t("todo.assign.title")}</MenuHead>
            <View style={{ paddingHorizontal: 6, paddingTop: 2, paddingBottom: 6 }}>
              <Field
                autoFocus={Platform.OS === "web"}
                value={q}
                onChangeText={setQ}
                placeholder={t("todo.assign.search")}
                accessibilityLabel={t("todo.assign.search")}
              />
            </View>
            {meIsMember && !(assignee?.kind === "user" && assignee.id === me) && !q ? (
              <MenuItem icon="user-circle" label={t("todo.assign.me")} onPress={() => pick({ kind: "user", id: me! })} />
            ) : null}
            <ScrollView style={{ maxHeight: 280 }}>
              {filtered.agents.length ? <MenuHead>{t("todo.assign.agents")}</MenuHead> : null}
              {filtered.agents.map((p) => (
                <PersonItem key={`a:${p.id}`} person={p} hint={p.role || t("todo.assign.agent")} checked={isCurrent(p)} onPress={() => pick({ kind: "agent", id: p.id })} />
              ))}
              {filtered.humans.length ? <MenuHead>{t("todo.assign.people")}</MenuHead> : null}
              {filtered.humans.map((p) => (
                <PersonItem
                  key={`u:${p.id}`}
                  person={p}
                  hint={p.id === me ? t("todo.assign.you") : t("todo.assign.person")}
                  checked={isCurrent(p)}
                  onPress={() => pick({ kind: "user", id: p.id })}
                />
              ))}
              {!filtered.agents.length && !filtered.humans.length ? (
                <Tx s={12.5} lh={18} c={td.txs} style={{ paddingHorizontal: 9, paddingVertical: 8 }}>
                  {t("todo.assign.noMatch")}
                </Tx>
              ) : null}
            </ScrollView>
            {assignee ? (
              <>
                <MenuSep />
                <MenuItem icon="x" label={t("todo.assign.remove")} onPress={() => pick(null)} />
              </>
            ) : null}
          </MenuBox>
        </StripMenu>
      ) : null}
    </View>
  )
}

export function PersonItem({ person, hint, checked, onPress }: { person: Person; hint: string; checked: boolean; onPress: () => void }) {
  const td = useTd()
  return (
    <Pressable
      accessibilityRole="menuitem"
      accessibilityState={{ checked }}
      onPress={onPress}
      style={({ hovered, focused }: any) => [
        { flexDirection: "row", alignItems: "center", gap: 9, minHeight: 34, paddingHorizontal: 9, borderRadius: 9, backgroundColor: hovered || focused ? td.wash2 : checked ? td.navActive : "transparent" },
        web({ cursor: "pointer", outlineStyle: "none" }) as ViewStyle,
      ]}
    >
      <PersonAvatar person={person} size={20} />
      <Tx s={12.5} lh={16} c={td.text} lines={1} style={{ flexShrink: 1 }}>
        {person.name}
      </Tx>
      <Tx f="mono" s={10} lh={14} c={td.txs} lines={1} style={{ marginLeft: "auto", paddingLeft: 12 }}>
        {hint}
      </Tx>
    </Pressable>
  )
}
