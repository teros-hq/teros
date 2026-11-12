/**
 * Face — a terminal as a squircle face: its colour is the terminal (stable
 * hash of its id), its expression is its state (working, needs you, done,
 * idle, asleep, frozen). People are circles; terminals are squircles.
 */

import { useId } from "react"
import { Text, View } from "react-native"
import Svg, { Circle, Defs, Ellipse, LinearGradient, Path, Rect, Stop } from "react-native-svg"
import type { TerminalSession } from "../terminalSessions"
import { type FaceState, FROZEN_FACE, faceColors, faceState } from "./crewModel"
import { css } from "./crewMotion"
import { useK } from "./tokens"

const INK = "#1A1020"

function Eyes({ state }: { state: FaceState }) {
  switch (state) {
    case "work":
      return (
        <>
          <Ellipse cx={14} cy={18} rx={3.2} ry={3.6} fill="#fff" />
          <Ellipse cx={26} cy={18} rx={3.2} ry={3.6} fill="#fff" />
          <Circle cx={13.4} cy={19.6} r={1.7} fill={INK} />
          <Circle cx={25.4} cy={19.6} r={1.7} fill={INK} />
          <Path d="M16 27h8" stroke={INK} strokeWidth={1.8} strokeLinecap="round" opacity={0.7} />
        </>
      )
    case "need":
      return (
        <>
          <Ellipse cx={14} cy={17} rx={3.4} ry={4} fill="#fff" />
          <Ellipse cx={26} cy={17} rx={3.4} ry={4} fill="#fff" />
          <Circle cx={14.6} cy={16} r={1.8} fill={INK} />
          <Circle cx={26.6} cy={16} r={1.8} fill={INK} />
          <Ellipse cx={20} cy={27.5} rx={2.6} ry={2.2} fill={INK} opacity={0.75} />
        </>
      )
    case "done":
      return (
        <>
          <Path
            d="M11 19.5q3-4 6 0M23 19.5q3-4 6 0"
            fill="none"
            stroke="#fff"
            strokeWidth={2.4}
            strokeLinecap="round"
          />
          <Path
            d="M15 25.5q5 4.5 10 0"
            fill="none"
            stroke={INK}
            strokeWidth={1.9}
            strokeLinecap="round"
            opacity={0.75}
          />
        </>
      )
    case "sleep":
      return (
        <>
          <Path
            d="M11 18q3 3 6 0M23 18q3 3 6 0"
            fill="none"
            stroke="#fff"
            strokeWidth={2.2}
            strokeLinecap="round"
            opacity={0.85}
          />
          <Path
            d="M17.5 27h5"
            stroke={INK}
            strokeWidth={1.6}
            strokeLinecap="round"
            opacity={0.45}
          />
        </>
      )
    default:
      return (
        <>
          <Path
            d="M10.8 18.5h6.4M22.8 18.5h6.4"
            stroke="#fff"
            strokeWidth={2.6}
            strokeLinecap="round"
          />
          <Path d="M16 27h8" stroke={INK} strokeWidth={1.8} strokeLinecap="round" opacity={0.55} />
        </>
      )
  }
}

interface FaceProps {
  /** The terminal (colour from its id, expression from its state)… */
  session?: TerminalSession
  /** …or both given directly (a face for a session not in the list yet). */
  terminalId?: string
  state?: FaceState
  size?: number
  /** Dimmed (floating elsewhere, being dragged). */
  dim?: boolean
  /** Drop shadow under the face (rail, bubble). */
  shadow?: boolean
}

export function Face({ session, terminalId, state, size = 40, dim, shadow }: FaceProps) {
  const rawId = useId()
  const K = useK()
  const gid = `face${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`
  const id = session?.terminalId ?? terminalId ?? ""
  const st: FaceState = state ?? (session ? faceState(session, Date.now()) : "idle")
  const [c1, c2] = st === "frozen" ? FROZEN_FACE : faceColors(id)
  return (
    <View
      style={[
        { width: size, height: size, opacity: dim ? 0.38 : st === "sleep" ? 0.62 : 1 },
        shadow ? css({ filter: K.shadowFace }) : null,
      ]}
      testID={`crew-face-${st}`}
    >
      <Svg width={size} height={size} viewBox="0 0 40 40">
        <Defs>
          <LinearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={c1} />
            <Stop offset="1" stopColor={c2} />
          </LinearGradient>
        </Defs>
        <Rect width={40} height={40} rx={13} fill={`url(#${gid})`} />
        <Rect x={1} y={1} width={38} height={20} rx={12} fill="#fff" opacity={0.12} />
        <Eyes state={st === "frozen" ? "idle" : st} />
      </Svg>
      {st === "frozen" ? (
        <Text
          style={{
            position: "absolute",
            right: -5,
            top: -7,
            fontSize: Math.max(10, Math.round(size * 0.3)),
            lineHeight: Math.max(12, Math.round(size * 0.34)),
            color: K.frozenMark,
          }}
        >
          ❄
        </Text>
      ) : null}
    </View>
  )
}
