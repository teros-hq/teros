/**
 * Registro: newest first, state changes drawn with dots, and a note field.
 * Entry text renders through the To Do markdown viewer (TODOMD-REQ-4); each
 * line shows who did it between the timestamp and the text (TODOLG-REQ-2).
 */
import React, { useState } from "react"
import { useTranslation } from "react-i18next"
import { View } from "react-native"
import { usePeople } from "../data/usePeople"
import { relativeDay, stamp, todayIso } from "../model/days"
import type { LogEntry } from "../model/types"
import { Btn, Dot, Eyebrow, Field, Tx } from "../ui/kit"
import { Markdown } from "../ui/Markdown"
import { useTd } from "../ui/tokens"
import { LogActor } from "./LogActor"
import { readLog } from "./logText"

/**
 * @spec TODOMD-REQ-4
 * @spec TODOLG-REQ-2
 */
export function LogTab({
  log,
  onNote,
  workspaceId,
}: {
  log: LogEntry[]
  onNote: (text: string) => void
  workspaceId?: string
}) {
  const td = useTd()
  const { find } = usePeople(workspaceId)
  const { t, i18n } = useTranslation()
  const locale = i18n.language || "en-US"
  const [text, setText] = useState("")
  const today = todayIso()
  const words = { today: t("todo.day.today"), tomorrow: t("todo.day.tomorrow"), yesterday: t("todo.day.yesterday") }
  const dayLabel = (d: string) => relativeDay(d, today, locale, words)
  const submit = () => {
    const v = text.trim()
    if (!v) return
    setText("")
    onNote(v)
  }
  const entries = log.slice().reverse()
  return (
    <View>
      <Eyebrow>{t("todo.section.log")}</Eyebrow>
      {entries.length === 0 ? (
        <Tx s={12.5} lh={18} c={td.txs}>
          {t("todo.log.empty")}
        </Tx>
      ) : (
        <View style={{ marginTop: 6 }}>
          {entries.map((e, i) => {
            const line = readLog(e, t, dayLabel)
            return (
              <View
                key={`${e.timestamp}-${i}`}
                style={{
                  flexDirection: "row",
                  gap: 10,
                  paddingVertical: 7,
                  borderBottomWidth: i === entries.length - 1 ? 0 : 1,
                  borderBottomColor: td.borderStrong,
                }}
              >
                <View style={{ width: 44 }}>
                  <Tx f="mono" s={10} lh={18} c={td.txs} lines={1}>
                    {stamp(e.timestamp, locale, t("todo.day.yesterday").toLowerCase())}
                  </Tx>
                </View>
                <LogActor actor={e.actor} find={find} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  {line.kind === "transition" ? (
                    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 5 }}>
                      <Dot state={line.from} size={6} still />
                      <Tx f="mono" s={11} lh={18} c={td.text}>
                        {`${t(`todo.state.${line.from}`).toLowerCase()} →`}
                      </Tx>
                      <Dot state={line.to} size={6} still />
                      <Tx f="mono" s={11} lh={18} c={td.text}>
                        {t(`todo.state.${line.to}`).toLowerCase()}
                      </Tx>
                      {line.note ? (
                        <Tx s={12.5} lh={18} c={td.text2}>
                          {`· ${line.note}`}
                        </Tx>
                      ) : null}
                    </View>
                  ) : (
                    <Markdown source={line.text} size={12.5} lh={18} tight />
                  )}
                </View>
              </View>
            )
          })}
        </View>
      )}
      <View style={{ flexDirection: "row", gap: 6, marginTop: 12 }}>
        <Field
          value={text}
          onChangeText={setText}
          onSubmitEditing={submit}
          height={34}
          placeholder={t("todo.log.addPlaceholder")}
          accessibilityLabel={t("todo.log.addPlaceholder")}
          style={{ flex: 1 }}
        />
        <Btn sm tone="out" height={34} onPress={submit}>
          {t("todo.log.add")}
        </Btn>
      </View>
    </View>
  )
}
