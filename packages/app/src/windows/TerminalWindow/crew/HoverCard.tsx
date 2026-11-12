/**
 * SlotHoverCard — a face's details, 12 px off the rail toward the canvas:
 * who it is, who drives since when, what it is doing, who watches, and two
 * actions (Float, Take the wheel).
 */

import { useTranslation } from "react-i18next"
import { Pressable, Text, View } from "react-native"
import { Ph } from "../../../components/ui/ds"
import { sessionLabel, type TerminalSession } from "../terminalSessions"
import type { RailSide } from "./CrewRail"
import { describeSeat, faceState } from "./crewModel"
import { css } from "./crewMotion"
import { driverLine } from "./driverLabel"
import { Face } from "./Face"
import { PersonAvatar, Seat } from "./Seat"
import { SANS, useK } from "./tokens"

export function kindLabel(s: TerminalSession): string {
  if (s.kind === "claude") return "Claude Code"
  if (s.kind === "codex") return "Codex"
  if (s.kind === "opencode") return "opencode"
  return s.command && s.command !== "bash" ? s.command : "shell"
}

export function clock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

/** "Dani mira" / "Dani y Lucía miran" / "Dani, Lucía y 2 más miran". */
export function watchersText(names: string[], t: (k: string, o: object) => string): string {
  if (names.length === 0) return ""
  if (names.length === 1)
    return t("terminal.crew.watchingOne", { defaultValue: "{{a}} is watching", a: names[0] })
  if (names.length === 2)
    return t("terminal.crew.watchingTwo", {
      defaultValue: "{{a}} and {{b}} are watching",
      a: names[0],
      b: names[1],
    })
  return t("terminal.crew.watchingMany", {
    defaultValue: "{{a}}, {{b}} and {{count}} more are watching",
    a: names[0],
    b: names[1],
    count: names.length - 2,
  })
}

interface HoverCardProps {
  session: TerminalSession
  side: RailSide
  top: number
  me?: string
  now: number
  onEnter: () => void
  onLeave: () => void
  onPopOut: () => void
  onTakeWheel: () => void
  onClose: () => void
}

export function HoverCard({
  session: s,
  side,
  top,
  me,
  now,
  onEnter,
  onLeave,
  onPopOut,
  onTakeWheel,
  onClose,
}: HoverCardProps) {
  const K = useK()
  const { t } = useTranslation()
  const view = describeSeat(s, me, now)
  const line = driverLine(view, me)
  const canTake = (view.seat === "agent" || view.seat === "need") && !view.mine
  const msg = s.agentState?.message
  return (
    <View
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      style={[
        {
          position: "absolute",
          top: Math.max(4, top),
          [side === "left" ? "left" : "right"]: "100%",
          [side === "left" ? "marginLeft" : "marginRight"]: 12,
          width: 252,
          zIndex: 40,
          backgroundColor: K.card,
          borderRadius: 12,
          paddingVertical: 11,
          paddingHorizontal: 12,
          gap: 8,
        },
        css({
          boxShadow: `${K.shadowCard}, inset 0 0 0 1px ${K.cardLine}`,
          animation: "crew-pop-in 120ms ease-out",
          cursor: "default",
        }),
      ]}
      testID="crew-hovercard"
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 9 }}>
        <Face session={s} state={faceState(s, now)} size={28} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            numberOfLines={1}
            style={{ fontFamily: SANS, fontSize: 13, fontWeight: "600", color: K.text }}
          >
            {sessionLabel(s)}
          </Text>
          <Text numberOfLines={1} style={{ fontFamily: SANS, fontSize: 11, color: K.dim }}>
            {kindLabel(s)}
            {s.lifecycle && s.lifecycle !== "awake"
              ? ` · ${s.lifecycle === "sleeping" ? t("terminal.crew.asleep", { defaultValue: "asleep" }) : t("terminal.crew.frozen", { defaultValue: "frozen" })}`
              : ""}
          </Text>
        </View>
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
        <Seat view={view} size={20} animate={false} />
        <Text numberOfLines={1} style={{ flex: 1, fontFamily: SANS, fontSize: 12, color: K.text }}>
          {line.who ? (
            <Text style={{ fontWeight: "600", color: line.color }}>{line.who} </Text>
          ) : null}
          <Text style={{ color: line.who ? K.text : K.text2 }}>{line.rest}</Text>
          {view.driver.since > 0 && view.seat !== "none" ? (
            <Text style={{ color: K.dim }}>
              {" · "}
              {t("terminal.crew.since", {
                defaultValue: "since {{time}}",
                time: clock(view.driver.since),
              })}
            </Text>
          ) : null}
        </Text>
      </View>

      {msg ? (
        <Text numberOfLines={2} style={{ fontFamily: SANS, fontSize: 11.5, color: K.text2 }}>
          {msg}
        </Text>
      ) : null}

      {view.watchers.length > 0 ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
          <Ph name="eye" size={12} color={K.dim} />
          <View style={{ flexDirection: "row" }}>
            {view.watchers.slice(0, 4).map((w, i) => (
              <View key={w.id} style={{ marginLeft: i === 0 ? 0 : -4 }}>
                <PersonAvatar person={w} size={16} />
              </View>
            ))}
          </View>
          <Text numberOfLines={1} style={{ flex: 1, fontFamily: SANS, fontSize: 12, color: K.dim }}>
            {watchersText(
              view.watchers.map((w) => w.name.split(/\s+/)[0] ?? w.name),
              t as never,
            )}
          </Text>
        </View>
      ) : null}

      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 6,
          borderTopWidth: 1,
          borderTopColor: K.cardSep,
          paddingTop: 9,
        }}
      >
        <CardBtn
          icon="picture-in-picture"
          label={t("terminal.crew.float", { defaultValue: "Float" })}
          kbd="⌘⇧F"
          onPress={onPopOut}
          testID="crew-card-float"
        />
        {canTake ? (
          <CardBtn
            icon="steering-wheel"
            label={t("terminal.crew.takeWheel", { defaultValue: "Take the wheel" })}
            tone={view.seat === "need" ? "amber" : "pri"}
            onPress={onTakeWheel}
            testID="crew-card-take"
          />
        ) : null}
        <View style={{ flex: 1 }} />
        <CardBtn
          icon="x"
          label={t("terminal.crew.closeShort", { defaultValue: "Close" })}
          tone="danger"
          onPress={onClose}
          testID="crew-card-close"
        />
      </View>
    </View>
  )
}

export function CardBtn({
  icon,
  label,
  kbd,
  tone,
  onPress,
  testID,
}: {
  icon: string
  label: string
  kbd?: string
  tone?: "pri" | "amber" | "danger"
  onPress: () => void
  testID?: string
}) {
  const K = useK()
  const bg = tone === "pri" ? K.btnPri : tone === "amber" ? K.amber : K.btn
  const fg =
    tone === "pri"
      ? K.ink
      : tone === "amber"
        ? K.amberInk
        : tone === "danger"
          ? K.dangerText
          : K.textHi
  return (
    <Pressable
      onPress={onPress}
      style={({ hovered }: any) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        height: 26,
        paddingHorizontal: 9,
        borderRadius: 8,
        backgroundColor: bg,
        opacity: hovered ? 0.88 : 1,
      })}
      testID={testID}
    >
      <Ph name={icon} size={12} color={fg} />
      <Text style={{ fontFamily: SANS, fontSize: 11.5, fontWeight: "500", color: fg }}>
        {label}
      </Text>
      {kbd ? (
        <Text style={{ fontFamily: "Reddit Mono", fontSize: 10, color: K.text3 }}>{kbd}</Text>
      ) : null}
    </Pressable>
  )
}
