/**
 * The reviewer chip of the detail header's strip (TODORV — docs/specs/todo/
 * reviewer.md): avatar + name, or the "manual validation" default (nobody
 * evaluates — Pablo, 31-oct), and its picker — the same searchable Agents /
 * People list as the assignee's (AssignChip), with "Assign to me" and
 * "Remove reviewer". Empty by default: no reviewer = nobody evaluates
 * automatically; the owner validates manually, exactly the previous behaviour.
 */
import React, { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Platform, Pressable, ScrollView, View, type ViewStyle } from "react-native"
import { Ph } from "../../../components/ui/ds"
import type { Person } from "../data/usePeople"
import type { Assignee } from "../model/types"
import { Field, MenuBox, MenuHead, MenuItem, MenuSep, Tx, useDismiss } from "../ui/kit"
import { web } from "../ui/todoFx"
import { useTd } from "../ui/tokens"
import { StripChip, StripMenu } from "./Chips"
import { PersonAvatar, PersonItem } from "./AssignChip"

export function ReviewerChip({
  reviewer,
  people,
  me,
  find,
  onSetReviewer,
}: {
  reviewer: Assignee | null
  people: Person[]
  me: string | null
  find: (a: Assignee | null) => Person | undefined
  onSetReviewer: (a: Assignee | null) => void
}) {
  const td = useTd()
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const ref = useRef<View>(null)
  const menuRef = useRef<any>(null)
  useDismiss(open, () => setOpen(false), ref, menuRef)
  const current = find(reviewer)
  const name = current?.name ?? (reviewer ? reviewer.id : null)

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
    onSetReviewer(a)
  }
  const isCurrent = (p: Person) => !!reviewer && reviewer.kind === p.kind && reviewer.id === p.id

  return (
    <View ref={ref}>
      <StripChip
        label={`${t("todo.chip.reviewer")}: ${name ?? t("todo.review.none")}`}
        expanded={open}
        onPress={() => setOpen((v) => !v)}
      >
        {current ? <PersonAvatar person={current} size={18} /> : null}
        <Tx s={12.5} lh={16} c={name ? td.text : td.text3} lines={1} style={{ maxWidth: 160 }}>
          {name ?? t("todo.review.none")}
        </Tx>
        <Ph name="caret-down" size={10} color={td.text3} />
      </StripChip>
      {open ? (
        <StripMenu anchor={ref} menuRef={menuRef}>
          <MenuBox label={t("todo.review.title")} minWidth={264}>
            <MenuHead>{t("todo.review.title")}</MenuHead>
            <View style={{ paddingHorizontal: 6, paddingTop: 2, paddingBottom: 6 }}>
              <Field
                autoFocus={Platform.OS === "web"}
                value={q}
                onChangeText={setQ}
                placeholder={t("todo.review.search")}
                accessibilityLabel={t("todo.review.search")}
              />
            </View>
            {meIsMember && !(reviewer?.kind === "user" && reviewer.id === me) && !q ? (
              <MenuItem icon="user-circle" label={t("todo.review.me")} onPress={() => pick({ kind: "user", id: me! })} />
            ) : null}
            <ScrollView style={{ maxHeight: 280 }}>
              {filtered.agents.length ? <MenuHead>{t("todo.review.agents")}</MenuHead> : null}
              {filtered.agents.map((p) => (
                <PersonItem key={`a:${p.id}`} person={p} hint={p.role || t("todo.review.agent")} checked={isCurrent(p)} onPress={() => pick({ kind: "agent", id: p.id })} />
              ))}
              {filtered.humans.length ? <MenuHead>{t("todo.review.people")}</MenuHead> : null}
              {filtered.humans.map((p) => (
                <PersonItem
                  key={`u:${p.id}`}
                  person={p}
                  hint={p.id === me ? t("todo.review.you") : t("todo.review.person")}
                  checked={isCurrent(p)}
                  onPress={() => pick({ kind: "user", id: p.id })}
                />
              ))}
              {!filtered.agents.length && !filtered.humans.length ? (
                <Tx s={12.5} lh={18} c={td.txs} style={{ paddingHorizontal: 9, paddingVertical: 8 }}>
                  {t("todo.review.noMatch")}
                </Tx>
              ) : null}
            </ScrollView>
            {reviewer ? (
              <>
                <MenuSep />
                <MenuItem icon="x" label={t("todo.review.remove")} onPress={() => pick(null)} />
              </>
            ) : null}
          </MenuBox>
        </StripMenu>
      ) : null}
    </View>
  )
}
