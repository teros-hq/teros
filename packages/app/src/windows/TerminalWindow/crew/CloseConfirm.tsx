/**
 * "Close «Tests»?" — asked only when closing would cut something off: a
 * coding agent mid-turn, a program in the foreground, someone else at the
 * wheel. ↵ closes, esc keeps it.
 */

import { useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Platform, Pressable, Text, View } from "react-native"
import { sessionLabel, type TerminalSession } from "../terminalSessions"
import type { CloseReason } from "./closeTerminal"
import { firstName } from "./crewModel"
import { css } from "./crewMotion"
import { Face } from "./Face"
import { SANS, useK } from "./tokens"

export function CloseConfirm({
  session,
  reason,
  onConfirm,
  onCancel,
}: {
  session: TerminalSession
  reason: CloseReason
  onConfirm: () => void
  onCancel: () => void
}) {
  const K = useK()
  const { t } = useTranslation()
  useEffect(() => {
    if (Platform.OS !== "web") return
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel()
      else if (e.key === "Enter") onConfirm()
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
  }, [onConfirm, onCancel])

  const why =
    reason?.kind === "working"
      ? t("terminal.crew.closeWorking", {
          defaultValue: "{{agent}} is in the middle of a turn: it stops here.",
          agent: reason.agent,
        })
      : reason?.kind === "program"
        ? t("terminal.crew.closeProgram", {
            defaultValue: "{{command}} is still running in it.",
            command: reason.command,
          })
        : reason?.kind === "driver"
          ? reason.agent
            ? t("terminal.crew.closeAgentDrives", {
                defaultValue: "{{name}} is at the wheel and loses this terminal.",
                name:
                  firstName(reason.name) ||
                  t("terminal.crew.theAgent", { defaultValue: "The agent" }),
              })
            : t("terminal.crew.closePersonDrives", {
                defaultValue: "{{name}} is at the wheel.",
                name: firstName(reason.name) || "?",
              })
          : ""

  const btn = (label: string, danger: boolean, onPress: () => void, testID: string) => (
    <Pressable
      onPress={onPress}
      style={({ hovered }: any) => ({
        height: 30,
        paddingHorizontal: 12,
        borderRadius: 8,
        justifyContent: "center",
        backgroundColor: danger ? K.danger : K.btn,
        opacity: hovered ? 0.9 : 1,
      })}
      testID={testID}
    >
      <Text
        style={{
          fontFamily: SANS,
          fontSize: 12.5,
          fontWeight: "500",
          color: danger ? K.onDanger : K.textHi,
        }}
      >
        {label}
      </Text>
    </Pressable>
  )

  return (
    <View
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        zIndex: 40,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: K.scrim,
        padding: 16,
      }}
      testID="crew-close-confirm"
    >
      <Pressable
        onPress={onCancel}
        style={[
          { position: "absolute", left: 0, top: 0, right: 0, bottom: 0 },
          css({ cursor: "default" }),
        ]}
      />
      <View
        style={[
          {
            width: 300,
            maxWidth: "100%",
            padding: 14,
            borderRadius: 14,
            backgroundColor: K.card,
            gap: 10,
          },
          css({
            boxShadow: `${K.shadowCard}, inset 0 0 0 1px ${K.cardLine}`,
            animation: "crew-pop-in 120ms ease-out",
          }),
        ]}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Face session={session} size={28} />
          <Text
            numberOfLines={1}
            style={{ flex: 1, fontFamily: SANS, fontSize: 14, fontWeight: "600", color: K.text }}
          >
            {t("terminal.crew.closeTitle", {
              defaultValue: "Close {{name}}?",
              name: sessionLabel(session),
            })}
          </Text>
        </View>
        {why ? (
          <Text style={{ fontFamily: SANS, fontSize: 12.5, lineHeight: 18, color: K.text2 }}>
            {why}
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 6, marginTop: 2 }}>
          {btn(
            t("terminal.crew.keep", { defaultValue: "Keep it" }),
            false,
            onCancel,
            "crew-close-cancel",
          )}
          {btn(
            t("terminal.crew.close", { defaultValue: "Close terminal" }),
            true,
            onConfirm,
            "crew-close-ok",
          )}
        </View>
      </View>
    </View>
  )
}
