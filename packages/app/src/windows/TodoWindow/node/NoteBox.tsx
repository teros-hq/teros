/**
 * The note card shared by the blocked task's reply and the send-back from
 * review (TODOAP-REQ-10, TODOAP-REQ-21): a header with a state dot, a serif
 * line, a text field with its primary button, and a footer. A violet cloud
 * sits behind the card (live box).
 *
 * The field carries the composer's dictation control (TODOAP-REQ-26; Pablo,
 * 2026-10-30): the SAME component the chat composer renders — mic → record →
 * stop → the transcript is written INTO the field (the composer's criteria:
 * existing text stays in front, joined with a space), and NOTHING is sent
 * until the field's own primary button is pressed. Cancelling the take
 * leaves the field exactly as it was.
 */
import React, { useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { View, type ViewStyle } from "react-native"
import { DictationControl, useDictationEngine } from "../../../components/ui/DictationControl"
import type { NodeState } from "../model/types"
import { Btn, Dot, Field, Tx } from "../ui/kit"
import { tdx, web } from "../ui/todoFx"
import { useTd } from "../ui/tokens"

const FIELD_H = 36
const MIC = 28

/** @spec TODOAP-REQ-21 TODOAP-REQ-26 */
export function NoteBox({
  region,
  dot,
  header,
  headerColor,
  at,
  title,
  placeholder,
  submitLabel,
  requireText,
  autoFocus,
  onSubmit,
  onCancel,
  onError,
  footer,
}: {
  region: string
  dot: NodeState
  header: string
  headerColor?: string
  at?: string | null
  title: string
  placeholder: string
  submitLabel: string
  /** Primary disabled while the trimmed text is empty. */
  requireText?: boolean
  autoFocus?: boolean
  onSubmit: (text: string) => void
  /** Esc in the field calls it too. */
  onCancel?: () => void
  /** A voice note that could not be recorded or transcribed (TODOAP-REQ-26). */
  onError?: (message: string) => void
  footer: ReactNode
}) {
  const td = useTd()
  const { t } = useTranslation()
  const [text, setText] = useState("")
  const empty = !text.trim()
  const submit = () => {
    if (busy) return
    const v = text.trim()
    if (!v) return
    setText("")
    onSubmit(v)
  }
  const engine = useDictationEngine({
    // The composer's landing criteria (handleTranscribe → setText): the
    // transcript REPLACES the field's content. The field is NOT submitted —
    // its own primary button does that.
    onTranscript: (spoken) => setText(spoken),
    onError: (_message, code) => {
      const key =
        code === "permission"
          ? t("recording.micDenied")
          : code === "unsupported"
            ? t("todo.voice.unsupported")
            : t("todo.voice.failed")
      onError?.(key)
    },
  })
  const busy = engine.state !== "idle"

  return (
    <View
      accessibilityRole="summary"
      accessibilityLabel={region}
      {...tdx("cloud")}
      style={[
        { position: "relative", marginTop: 14, borderRadius: 16, paddingTop: 14, paddingRight: 14, paddingBottom: 12, paddingLeft: 16, backgroundColor: td.card, gap: 10 },
        web({ boxShadow: `${td.cardShadow}, 0 0 0 1px ${td.ring}` }) as ViewStyle,
      ]}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Dot state={dot} />
        <Tx f="mono" s={10} lh={14} c={headerColor ?? td.txs} ls={1} upper lines={1} style={{ flexShrink: 1 }}>
          {header}
        </Tx>
        {at ? (
          <Tx f="mono" s={10} lh={14} c={td.txs} style={{ marginLeft: "auto" }}>
            {at}
          </Tx>
        ) : null}
      </View>
      <Tx f="serif" s={17} lh={24} c={td.text}>
        {title}
      </Tx>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <View style={{ flex: 1, minWidth: 150, position: "relative", justifyContent: "center" }}>
          {engine.state === "recording" || engine.state === "stopped" || engine.state === "transcribing" ? (
            // The composer's recording row takes the field's place (the pill
            // swaps its textarea for the row). Same control, same visuals.
            <View
              accessibilityRole="none"
              style={{ height: FIELD_H, borderRadius: 100, backgroundColor: td.sheet, paddingLeft: 4, paddingRight: 4 }}
            >
              <DictationControl
                engine={engine}
                compact
                micSize={MIC}
                iconSize={16}
                label={t("todo.voice.record")}
                micTitle={t("todo.voice.record")}
                testID="note-dictation"
              />
            </View>
          ) : (
            <>
              <Field
                autoFocus={autoFocus}
                value={text}
                onChangeText={setText}
                onSubmitEditing={busy ? undefined : submit}
                onKeyPress={onCancel ? (e) => e.nativeEvent.key === "Escape" && !busy && onCancel() : undefined}
                editable={!busy}
                aria-disabled={busy || undefined}
                height={FIELD_H}
                placeholder={placeholder}
                accessibilityLabel={placeholder}
                style={{ paddingRight: MIC + 10, opacity: busy ? 0.6 : 1 }}
              />
              <View style={{ position: "absolute", right: (FIELD_H - MIC) / 2, top: (FIELD_H - MIC) / 2 }}>
                <DictationControl
                  engine={engine}
                  compact
                  micSize={MIC}
                  iconSize={16}
                  label={t("todo.voice.record")}
                  micTitle={t("todo.voice.record")}
                  testID="note-dictation"
                />
              </View>
            </>
          )}
        </View>
        <Btn tone="mint" icon="arrow-up" height={FIELD_H} disabled={busy || (requireText && empty)} onPress={submit}>
          {submitLabel}
        </Btn>
      </View>
      {footer}
    </View>
  )
}
