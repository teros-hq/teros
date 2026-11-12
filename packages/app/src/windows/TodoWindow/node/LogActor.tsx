/**
 * Who did a log line (docs/specs/todo/log-actor.md, TODOLG-REQ-2): a 16 px
 * avatar between the timestamp and the text — the person or agent from the
 * workspace member list, the Teros mark for the system, the generic person
 * glyph for an id the list does not know, and an empty slot of the same width
 * for an entry without actor so every line's text starts at the same x.
 * The name is the accessibility label and the web tooltip.
 */
import React, { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { Platform, View } from "react-native"
import { TerosLogo } from "../../../components/TerosLogo"
import { Ph } from "../../../components/ui/ds"
import type { Person } from "../data/usePeople"
import type { Assignee, LogActor as Actor } from "../model/types"
import { useTd } from "../ui/tokens"
import { PersonAvatar } from "./AssignChip"

export const LOG_ACTOR_SIZE = 16

/** @spec TODOLG-REQ-2 */
export function LogActor({
  actor,
  find,
}: {
  actor: Actor | undefined
  find: (a: Assignee | null | undefined) => Person | undefined
}) {
  const td = useTd()
  const { t } = useTranslation()
  const ref = useRef<View | null>(null)
  const person = actor && actor.kind !== "system" && actor.id ? find({ kind: actor.kind, id: actor.id }) : undefined
  const label = !actor
    ? null
    : actor.kind === "system"
      ? "Teros"
      : (person?.name ?? (actor.kind === "agent" ? t("todo.assign.agent") : t("todo.assign.person")))

  // Hover tooltip = the name (web `title`; react-native-web does not forward the prop).
  useEffect(() => {
    const el = ref.current as unknown as HTMLElement | null
    if (Platform.OS === "web" && el?.setAttribute && label) el.setAttribute("title", label)
  }, [label])

  const box = { width: LOG_ACTOR_SIZE, height: LOG_ACTOR_SIZE, marginTop: 1, flexShrink: 0 } as const
  if (!actor) return <View style={box} testID="log-actor-none" />
  return (
    <View
      ref={ref}
      style={[box, { alignItems: "center", justifyContent: "center" }]}
      accessible
      accessibilityLabel={label ?? undefined}
      testID={`log-actor-${actor.kind}`}
    >
      {actor.kind === "system" ? (
        <View testID="teros-mark">
          <TerosLogo size={LOG_ACTOR_SIZE} color={td.text3} animated={false} />
        </View>
      ) : person ? (
        <PersonAvatar person={person} size={LOG_ACTOR_SIZE} />
      ) : (
        <Ph name="user-circle" size={LOG_ACTOR_SIZE} color={td.text3} />
      )}
    </View>
  )
}
