/**
 * DriverHeader — the terminal's slim 44 px header: who drives ("Atlas
 * conduce"), the terminal's name, what it is doing and for how long, who
 * watches, ONE action that depends on the driver, pop-out and the menu.
 *
 *   Atlas drives      → Take the wheel
 *   you drive         → Give back to Atlas (optional note)
 *   someone else      → Ask for the wheel
 *   needs you (amber) → Take the wheel
 *   two at once (red) → Let them / Ask for it
 *   nobody            → (nothing: just type)
 */

import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Platform, Pressable, Text, TextInput, View } from "react-native"
import { Ph } from "../../../components/ui/ds"
import { sessionLabel, type TerminalSession } from "../terminalSessions"
import { type CrewPerson, elapsed, isUnnamedAgent, SEAT_COLORS, type SeatView } from "./crewModel"
import { css } from "./crewMotion"
import { driverLine } from "./driverLabel"
import { PersonAvatar, Seat } from "./Seat"
import { SANS, useK } from "./tokens"

interface HeaderProps {
  session: TerminalSession
  view: SeatView
  narrow: boolean
  now: number
  me?: string
  /** The agent that drove before (Give back goes to it). */
  copilot: CrewPerson | null
  menuOpen: boolean
  onTake: () => void
  onGiveBack: (note: string | null) => void
  onYield: (to: string) => void
  onPopOut: () => void
  onMenu: () => void
}

function HBtn({
  label,
  icon,
  avatar,
  tone,
  onPress,
  testID,
}: {
  label: string
  icon?: string
  avatar?: React.ReactNode
  tone?: "pri" | "amber" | "clash"
  onPress: () => void
  testID?: string
}) {
  const K = useK()
  const bg =
    tone === "pri"
      ? K.btnPri
      : tone === "amber"
        ? SEAT_COLORS.need.ring
        : tone === "clash"
          ? K.clashBtn
          : K.btn
  const fg = tone === "pri" ? K.ink : tone === "amber" ? K.amberInk : K.textHi
  return (
    <Pressable
      onPress={onPress}
      style={({ hovered, pressed }: any) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        height: 28,
        paddingHorizontal: 10,
        borderRadius: 8,
        backgroundColor: bg,
        opacity: pressed ? 0.8 : hovered ? 0.9 : 1,
        flexShrink: 0,
      })}
      testID={testID}
    >
      {avatar ?? (icon ? <Ph name={icon} size={13} color={fg} /> : null)}
      <Text
        style={{ fontFamily: SANS, fontSize: 12, fontWeight: "500", color: fg }}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  )
}

export function HIconBtn({
  icon,
  label,
  active,
  onPress,
  testID,
}: {
  icon: string
  label: string
  active?: boolean
  onPress: () => void
  testID?: string
}) {
  const K = useK()
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={label}
      // @ts-expect-error web-only title tooltip
      title={label}
      style={({ hovered }: any) => ({
        width: 28,
        height: 28,
        borderRadius: 8,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: hovered || active ? K.btn : "transparent",
        flexShrink: 0,
      })}
      testID={testID}
    >
      <Ph name={icon} size={14} color={active ? K.onAccent : K.text3} />
    </Pressable>
  )
}

export function TerminalHeader(p: HeaderProps) {
  const K = useK()
  const { t } = useTranslation()
  const { session: s, view, narrow, now, me, copilot } = p
  const [noteOpen, setNoteOpen] = useState(false)
  const line = driverLine(view, me)
  const need = view.seat === "need"
  // An agent the backend could not name is "the agent" (Devolver al agente).
  const agentName = copilot && !isUnnamedAgent(copilot) ? copilot.name.split(/\s+/)[0] : undefined
  // The co-pilot sits next to the seat, not among the watchers.
  const watchers =
    view.mine && copilot ? view.watchers.filter((w) => w.id !== copilot.id) : view.watchers
  const clash = view.seat === "clash"

  // Line two: the terminal, then what it does and for how long (wide only).
  const since =
    need && s.agentState?.at ? Date.parse(s.agentState.at) || view.driver.since : view.driver.since
  const extra: string[] = []
  if (!narrow) {
    if (view.mine && copilot)
      extra.push(
        t("terminal.crew.copilotWaits", {
          defaultValue: "{{name}} waits as co-pilot",
          name: agentName ?? t("terminal.crew.theAgent", { defaultValue: "The agent" }),
        }),
      )
    else if (clash)
      extra.push(
        t("terminal.crew.clashHint", {
          defaultValue: "both of your keystrokes reach the same line",
        }),
      )
    else if (s.agentState?.message && view.seat !== "none") extra.push(s.agentState.message)
    if (view.seat !== "none" && !clash && since > 0) extra.push(elapsed(since, now))
  }

  let action: React.ReactNode = null
  if (view.seat === "agent" || need) {
    action = (
      <HBtn
        label={
          narrow
            ? t("terminal.crew.take", { defaultValue: "Take" })
            : t("terminal.crew.takeWheel", { defaultValue: "Take the wheel" })
        }
        icon="steering-wheel"
        tone={need ? "amber" : "pri"}
        onPress={p.onTake}
        testID="crew-take"
      />
    )
  } else if (view.seat === "human" && view.mine) {
    action = (
      <HBtn
        label={
          narrow
            ? t("terminal.crew.giveBackShort", { defaultValue: "Give back" })
            : agentName
              ? t("terminal.crew.giveBackTo", {
                  defaultValue: "Give back to {{name}}",
                  name: agentName,
                })
              : t("terminal.crew.letGo", { defaultValue: "Let go of the wheel" })
        }
        avatar={copilot ? <PersonAvatar person={copilot} size={14} /> : undefined}
        icon="steering-wheel"
        onPress={() => setNoteOpen(true)}
        testID="crew-giveback"
      />
    )
  } else if (view.seat === "human") {
    action = (
      <HBtn
        label={
          narrow
            ? t("terminal.crew.ask", { defaultValue: "Ask" })
            : t("terminal.crew.askWheel", { defaultValue: "Ask for the wheel" })
        }
        icon="hand"
        onPress={p.onTake}
        testID="crew-ask"
      />
    )
  } else if (clash) {
    const other = view.clash.find((x) => x.id !== me)
    action = (
      <>
        <HBtn
          label={t("terminal.crew.yield", { defaultValue: "Let them" })}
          tone="clash"
          onPress={() => other && p.onYield(other.id)}
          testID="crew-yield"
        />
        <HBtn
          label={t("terminal.crew.claim", { defaultValue: "Ask for it" })}
          tone="pri"
          onPress={p.onTake}
          testID="crew-claim"
        />
      </>
    )
  }

  const surface = need
    ? { bg: K.needBg, bg2: K.needBg2, line: K.needLine }
    : clash
      ? { bg: K.clashBg, bg2: K.clashBg2, line: K.clashLine }
      : { bg: K.rail, bg2: K.rail, line: K.line }

  return (
    <View style={{ zIndex: 6 }}>
      <View
        style={[
          {
            height: 44,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingLeft: 12,
            paddingRight: 8,
            borderBottomWidth: 1,
            borderBottomColor: surface.line,
            backgroundColor: surface.bg,
          },
          need || clash
            ? css({ backgroundImage: `linear-gradient(${surface.bg}, ${surface.bg2})` })
            : null,
        ]}
        testID={`crew-header-${view.seat}`}
      >
        <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 2 }}>
          <Seat view={view} size={24} gap={surface.bg} />
          {view.mine && copilot ? (
            <View style={{ marginLeft: 7, opacity: 0.9 }} accessibilityLabel={copilot.name}>
              <PersonAvatar person={copilot} size={16} />
              <View
                pointerEvents="none"
                style={{
                  position: "absolute",
                  left: -3,
                  top: -3,
                  width: 22,
                  height: 22,
                  borderRadius: 11,
                  borderWidth: 1.5,
                  borderStyle: "dashed",
                  borderColor: SEAT_COLORS.agent.ring,
                }}
              />
            </View>
          ) : null}
        </View>

        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            numberOfLines={1}
            style={{ fontFamily: SANS, fontSize: 12.5, lineHeight: 16, color: K.text }}
          >
            {line.who ? (
              <Text style={{ fontWeight: "600", color: line.color }}>{line.who} </Text>
            ) : null}
            <Text style={{ color: line.who ? K.text : K.text2 }}>{line.rest}</Text>
          </Text>
          <Text
            numberOfLines={1}
            style={{ fontFamily: SANS, fontSize: 11, lineHeight: 14, color: K.dim2 }}
          >
            <Text style={{ fontWeight: "600", color: K.text2 }}>{sessionLabel(s)}</Text>
            {extra.length ? ` · ${extra.join(" · ")}` : ""}
          </Text>
        </View>

        {!narrow && watchers.length > 0 ? (
          <View
            style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
            accessibilityLabel={watchers.map((w) => w.name).join(", ")}
            // @ts-expect-error web-only title tooltip
            title={`${t("terminal.crew.watching", { defaultValue: "Watching" })}: ${watchers.map((w) => w.name).join(", ")}`}
            testID="crew-watchers"
          >
            <Ph name="eye" size={11} color={K.dim2} />
            {watchers.slice(0, 4).map((w, i) => (
              <View
                key={w.id}
                style={[
                  { marginLeft: i === 0 ? 0 : -7, borderRadius: 10 },
                  css({ boxShadow: `0 0 0 2px ${surface.bg}` }),
                ]}
              >
                <PersonAvatar person={w} size={16} />
              </View>
            ))}
          </View>
        ) : null}

        {action}

        <HIconBtn
          icon="picture-in-picture"
          label={`${t("terminal.crew.float", { defaultValue: "Float" })} (⌘⇧F)`}
          onPress={p.onPopOut}
          testID="crew-popout"
        />
        <HIconBtn
          icon="dots-three"
          label={t("terminal.crew.more", { defaultValue: "More" })}
          active={p.menuOpen}
          onPress={p.onMenu}
          testID="crew-menu"
        />
      </View>

      {noteOpen ? (
        <GiveBackPopover
          agentName={agentName}
          onCancel={() => setNoteOpen(false)}
          onSend={(note) => {
            setNoteOpen(false)
            p.onGiveBack(note)
          }}
        />
      ) : null}
    </View>
  )
}

/** "Devolver a Atlas" with an optional note: ↵ sends it, esc gives back without one. */
function GiveBackPopover({
  agentName,
  onSend,
  onCancel,
}: {
  agentName?: string
  onSend: (note: string | null) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const K = useK()
  const [note, setNote] = useState("")
  const input = useRef<TextInput>(null)
  useEffect(() => {
    const id = setTimeout(() => input.current?.focus(), 30)
    return () => clearTimeout(id)
  }, [])
  const send = () => onSend(note.trim() ? note.trim() : null)
  return (
    <>
      <Pressable
        onPress={onCancel}
        style={[
          { position: "fixed" as any, left: 0, top: 0, right: 0, bottom: 0, zIndex: 33 },
          css({ cursor: "default" }),
        ]}
      />
      <View
        style={[
          {
            position: "absolute",
            right: 10,
            top: 48,
            width: 280,
            zIndex: 34,
            backgroundColor: K.card,
            borderRadius: 12,
            padding: 11,
          },
          css({
            boxShadow: `${K.shadowCard}, inset 0 0 0 1px ${K.cardLine}`,
            animation: "crew-pop-in 120ms ease-out",
          }),
        ]}
        testID="crew-giveback-popover"
      >
        <Text style={{ fontFamily: SANS, fontSize: 12.5, fontWeight: "600", color: K.text }}>
          {agentName
            ? t("terminal.crew.giveBackTo", {
                defaultValue: "Give back to {{name}}",
                name: agentName,
              })
            : t("terminal.crew.letGo", { defaultValue: "Let go of the wheel" })}
        </Text>
        <TextInput
          ref={input}
          value={note}
          onChangeText={setNote}
          multiline
          placeholder={t("terminal.crew.notePlaceholder", {
            defaultValue: "A note for {{name}} (optional)",
            name: agentName ?? t("terminal.crew.theAgentLower", { defaultValue: "the agent" }),
          })}
          placeholderTextColor={K.faint}
          onKeyPress={(e: any) => {
            const key = e.nativeEvent?.key
            if (key === "Enter" && !e.nativeEvent?.shiftKey) {
              e.preventDefault?.()
              send()
            } else if (key === "Escape") {
              e.preventDefault?.()
              onSend(null)
            }
          }}
          style={[
            {
              marginTop: 7,
              minHeight: 52,
              backgroundColor: K.inputBg,
              borderRadius: 8,
              paddingVertical: 8,
              paddingHorizontal: 10,
              color: K.inputText,
              fontFamily: SANS,
              fontSize: 12,
              borderWidth: 1,
              borderColor: K.inputLine,
            },
            Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : null,
          ]}
          testID="crew-giveback-note"
        />
        <View style={{ flexDirection: "row", gap: 6, marginTop: 9, justifyContent: "flex-end" }}>
          <HBtn
            label={t("terminal.crew.noNote", { defaultValue: "No note" })}
            onPress={() => onSend(null)}
            testID="crew-giveback-nonote"
          />
          <HBtn
            label={`${t("terminal.crew.giveBackShort", { defaultValue: "Give back" })} ↵`}
            tone="pri"
            onPress={send}
            testID="crew-giveback-send"
          />
        </View>
      </View>
    </>
  )
}
