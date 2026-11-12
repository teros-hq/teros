/**
 * CallChip — the prototype's `call-chip`: the unit of a tool call in the chat.
 *
 * A 34px pill on the wash that hugs its content: the app glyph ALWAYS on
 * the left (context: which app did it — Gmail vs Google Calendar), a
 * descriptive label in sans 13 — "Enviando email a ana@…", then "Email
 * enviado a ana@…" — the renderer's wording for the state. An optional grey
 * argument follows when the label does not already say it, and the outcome
 * sits at the right end: a green check when done, a red retry arrow when
 * failed (slides in from below). While running a
 * violet fill sweeps the pill over `expectedMs`; when done the fill turns
 * green and closes upwards; when failed it turns red.
 */
import React, { useEffect, useRef, useState } from "react"
import { Platform, View } from "react-native"
import { T } from "../../ui/ds/Text"
import { Ph } from "../../ui/ds/Icon"
import { McaIcon } from "../McaIcon"
import { statusDotColors, type McaStatusType } from "./colors"
import "./StatusDot" // injects the mca-status-pulse keyframes
import { useColors } from "./useColors"

export type ChipStatus = "idle" | "running" | "done" | "error"

export function chipStatusOf(status: McaStatusType): ChipStatus {
  if (status === "running") return "running"
  if (status === "completed") return "done"
  if (status === "failed") return "error"
  return "idle"
}

export interface CallChipProps {
  status: McaStatusType
  iconUri?: string
  /** Title — what is happening / happened ("Sending email"). */
  label: string
  /** Subtitle — the headline value, grey ("ana@gmail.com"). */
  argument?: string
  /** How long the sweep takes to reach ~92% while running. */
  expectedMs?: number
  size?: number
  radius?: number
  /** Dimmed with the name struck through — denied / cancelled. */
  off?: boolean
}

const EASE = "cubic-bezier(.23,1,.32,1)"

export function CallChip({
  status,
  iconUri,
  label,
  argument,
  expectedMs = 2500,
  size = 34,
  radius = 12,
  off,
}: CallChipProps) {
  const c = useColors()
  const chip = chipStatusOf(status)
  const web = Platform.OS === "web"
  // Mounted flag: transitions only after first paint (prototype data-mounted).
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(id)
  }, [])
  // Remember we were running so a done chip still shows the sweep closing.
  const ranRef = useRef(chip === "running")
  if (chip === "running") ranRef.current = true

  // Status fills (theme-independent, the same greens/reds the header icon
  // uses) for the glyph swap and the sweep; the note text uses the tints.
  const green = statusDotColors.completed.fill
  const red = statusDotColors.failed.fill
  const fillColor = chip === "done" ? `${green}24` : chip === "error" ? `${red}24` : `${c.accent}1f`
  const fillStyle = web
    ? ({
        position: "absolute",
        left: 0,
        top: 0,
        bottom: 0,
        width: "100%",
        backgroundColor: fillColor,
        transformOrigin: "0 50%",
        transform:
          chip === "running" ? "scaleX(0.92)" : chip === "idle" ? "scaleX(0)" : "scaleX(1)",
        clipPath: chip === "done" ? "inset(100% 0 0)" : "inset(0)",
        pointerEvents: "none",
        transition: !mounted
          ? "none"
          : chip === "running"
            ? `transform ${expectedMs}ms linear, background-color .12s`
            : chip === "done"
              ? `transform .2s ${EASE}, background-color .12s ease, clip-path .4s ${EASE} .2s`
              : "background-color .2s",
      } as any)
    : null

  // Glyph slot: the app icon.
  const slot = size * 0.45
  // The app mark stays put in every state; it turns violet and pulses while
  // the call runs (same clock as the status pulse).
  const iconTint = chip === "running" ? c.accent : c.text
  const pulse =
    web && chip === "running"
      ? ({ animation: "mca-status-pulse 1.6s infinite ease-in-out" } as any)
      : null
  // Trailing outcome mark: slides up into place once the call settles.
  const settled = chip === "done" || chip === "error"
  const markSize = size * 0.4
  const markStyle = web
    ? ({
        opacity: settled ? 1 : 0,
        transform: settled ? "translateY(0)" : "translateY(70%)",
        filter: settled ? "blur(0)" : "blur(3px)",
        transition: mounted
          ? `opacity .24s ${EASE}, transform .24s ${EASE}, filter .24s ${EASE}`
          : "none",
      } as any)
    : null

  return (
    <View
      accessibilityRole="text"
      style={[
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 7,
          height: size,
          paddingHorizontal: 12,
          borderRadius: radius,
          backgroundColor: c.wash2,
          overflow: "hidden",
          maxWidth: "100%",
          flexShrink: 1,
          opacity: off ? 0.6 : 1,
        },
        web ? ({ position: "relative", userSelect: "none", whiteSpace: "nowrap" } as any) : null,
      ]}
    >
      {web ? <View style={fillStyle} /> : null}
      <View
        style={[
          { width: slot, height: slot, alignItems: "center", justifyContent: "center" },
          pulse,
        ]}
      >
        {iconUri ? (
          <McaIcon icon={iconUri} size={slot - 2} borderRadius={2} color={iconTint} />
        ) : (
          <Ph name="cube" size={slot - 2} color={iconTint} />
        )}
      </View>
      <T
        step="sm"
        numberOfLines={1}
        style={[
          { fontSize: 13, lineHeight: 16, flexShrink: 0, minWidth: 0 },
          off && web ? ({ textDecorationLine: "line-through" } as any) : null,
        ]}
      >
        {label}
      </T>
      {argument ? (
        <T
          step="sm"
          tone="text3"
          numberOfLines={1}
          style={{ fontSize: 13, lineHeight: 15, flexShrink: 1, minWidth: 0 }}
        >
          {argument}
        </T>
      ) : null}
      {settled || web ? (
        <View
          accessibilityLabel={chip === "done" ? "Done" : chip === "error" ? "Failed" : undefined}
          style={[
            {
              width: settled ? markSize : 0,
              height: markSize,
              marginLeft: settled ? 3 : -7,
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              minWidth: settled ? markSize : 0,
            },
            web
              ? ({
                  transition: mounted ? `width .24s ${EASE}, margin-left .24s ${EASE}` : "none",
                } as any)
              : null,
            markStyle,
          ]}
        >
          {chip === "error" ? (
            <Ph name="arrow-clockwise" size={markSize} color={red} weight="bold" />
          ) : (
            <Ph name="check" size={markSize} color={green} weight="bold" />
          )}
        </View>
      ) : null}
    </View>
  )
}
