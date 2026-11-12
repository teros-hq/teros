/**
 * Seat — who drives a terminal, as a small circle on the corner of its face
 * (or inline, in a header): the driver's avatar in their colour, an empty
 * grey wheel (nobody), an amber dashed wheel that turns (needs you), or two
 * avatars in red (two people typing at once). The same seat in the rail, the
 * header, a floating window, a bubble, the hover card and the chat.
 *
 * Sizes (spec): 20 in the rail, 18 narrow, 24 in the header, 14 floating;
 * ring 2 in the driver's colour + gap 2 in the background colour behind it.
 */

import { useState } from "react"
import { Image, Platform, Text, View } from "react-native"
import Svg, { Circle, Path } from "react-native-svg"
import { FONT_SANS } from "../../../components/mca/primitives/fonts"
import { getAvatarUrl } from "../../../lib/image-url"
import { useAuthStore } from "../../../store/authStore"
import type { TerminalSession } from "../terminalSessions"
import {
  type CrewPerson,
  describeSeat,
  initials,
  personColor,
  SEAT_COLORS,
  type SeatView,
  seatColor,
} from "./crewModel"
import { anim } from "./crewMotion"
import { useK } from "./tokens"

export function WheelIcon({ size, color }: { size: number; color: string }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Circle cx={12} cy={12} r={8} />
      <Circle cx={12} cy={12} r={2} />
      <Path d="M12 14v6" />
      <Path d="m10.2 12.9-5.6 3.3" />
      <Path d="m13.8 12.9 5.6 3.3" />
    </Svg>
  )
}

/** An agent without a portrait: a violet orb with an "A". */
function AgentOrb({ size }: { size: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 40 40">
      <Circle cx={20} cy={20} r={20} fill="#7C3AED" />
      <Circle cx={15} cy={13} r={12} fill="#C9B2FF" opacity={0.45} />
      <Path
        d="M11 27 20 10l9 17"
        fill="none"
        stroke="#fff"
        strokeWidth={2.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.92}
      />
      <Path
        d="M14.5 21.5h11"
        stroke="#fff"
        strokeWidth={2.6}
        strokeLinecap="round"
        opacity={0.92}
      />
    </Svg>
  )
}

/** A person (circle) or an agent (orb, or its portrait). */
export function PersonAvatar({
  person,
  size,
}: {
  person: Pick<CrewPerson, "id" | "kind" | "name" | "avatarUrl">
  size: number
}) {
  const K = useK()
  const [failed, setFailed] = useState(false)
  const url = person.avatarUrl && !failed ? getAvatarUrl(person.avatarUrl, size) : null
  if (url) {
    return (
      <Image
        source={{ uri: url }}
        onError={() => setFailed(true)}
        style={{ width: size, height: size, borderRadius: size / 2 }}
        accessibilityLabel={person.name}
      />
    )
  }
  if (person.kind === "agent") return <AgentOrb size={size} />
  const col = personColor(person.id)
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: col.ring,
        alignItems: "center",
        justifyContent: "center",
        ...(Platform.OS === "web"
          ? ({ backgroundImage: `linear-gradient(140deg, ${col.text}, ${col.ring})` } as object)
          : null),
      }}
      accessibilityLabel={person.name}
    >
      <Text
        style={{
          fontSize: Math.max(7, Math.round(size * 0.46)),
          lineHeight: Math.max(8, Math.round(size * 0.56)),
          fontWeight: "700",
          color: K.avatarInk,
          fontFamily: FONT_SANS,
        }}
      >
        {initials(person.name).slice(0, size < 18 ? 1 : 2)}
      </Text>
    </View>
  )
}

interface SeatProps {
  /** A session (the seat is derived for the signed-in person)… */
  session?: TerminalSession
  /** …or an already derived seat. */
  view?: SeatView
  /** Diameter of the seat (the ring and gap are drawn outside it). */
  size?: number
  /** Colour behind the seat (the gap ring). Default: the rail. */
  gap?: string
  /** Corner of a face (absolute, offset 7 / 5) or inline in a row. */
  corner?: boolean
  /** Corner offset (spec: −7 in the rail, −5 floating / bubble). */
  offset?: number
  /** Breathing allowed (the header and the rail; off in static lists). */
  animate?: boolean
}

export function Seat({
  session,
  view: given,
  size = 20,
  gap,
  corner = false,
  offset = 7,
  animate = true,
}: SeatProps) {
  const me = useAuthStore((s) => s.user?.userId)
  const K = useK()
  const gapColor = gap ?? K.rail
  const view = given ?? (session ? describeSeat(session, me, Date.now()) : null)
  if (!view) return null
  const { ring } = seatColor(view)
  const clash = view.seat === "clash"
  const w = clash ? size + 9 : size
  const gapW = corner ? 2 : 0
  const outerW = w + 4 + gapW * 2
  const outerH = size + 4 + gapW * 2
  const r = outerH / 2

  let inner: React.ReactNode
  let disc: string = K.seatDisc
  let ringColor: string = ring
  switch (view.seat) {
    case "none":
      disc = K.seatDiscIdle
      inner = <WheelIcon size={Math.round(size * 0.62)} color={K.seatWheelIdle} />
      break
    case "need":
      disc = K.seatDiscNeed
      ringColor = "transparent"
      inner = <WheelIcon size={Math.round(size * 0.62)} color={SEAT_COLORS.need.ring} />
      break
    case "clash":
      disc = K.seatDiscClash
      inner = (
        <View style={{ flexDirection: "row" }}>
          {view.clash.map((p, i) => (
            <View key={p.id} style={{ marginLeft: i === 0 ? 0 : -5 }}>
              <PersonAvatar person={p} size={size - 4} />
            </View>
          ))}
        </View>
      )
      break
    default:
      inner = (
        <View
          key={view.driver.id ?? view.seat}
          style={anim("crew-seat-in 240ms cubic-bezier(.2,.8,.2,1)")}
        >
          <PersonAvatar
            person={{
              id: view.driver.id ?? "",
              kind: view.driver.kind === "agent" ? "agent" : "human",
              name: view.driver.name ?? "",
              avatarUrl: view.driver.avatarUrl,
            }}
            size={size - 4}
          />
        </View>
      )
  }

  const box = (
    <View
      style={[
        {
          width: outerW,
          height: outerH,
          borderRadius: r,
          backgroundColor: corner ? gapColor : "transparent",
          alignItems: "center",
          justifyContent: "center",
        },
        corner
          ? { position: "absolute", right: -offset - gapW - 2, bottom: -offset - gapW - 2 }
          : null,
        clash ? anim("crew-shake .45s ease-in-out 3") : null,
      ]}
      testID={`crew-seat-${view.seat}`}
      accessibilityLabel={view.driver.name}
    >
      {view.live && animate ? (
        <View
          pointerEvents="none"
          style={[
            {
              position: "absolute",
              left: gapW - 3,
              top: gapW - 3,
              width: w + 10,
              height: size + 10,
              borderRadius: (size + 10) / 2,
              borderWidth: 3,
              borderColor: `${ring}47`,
              opacity: 0,
            },
            anim("crew-breathe 1.8s ease-in-out infinite"),
          ]}
        />
      ) : null}
      <View
        style={{
          width: w + 4,
          height: size + 4,
          borderRadius: (size + 4) / 2,
          backgroundColor: ringColor,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <View
          style={{
            width: w,
            height: size,
            borderRadius: size / 2,
            backgroundColor: disc,
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
          }}
        >
          {inner}
        </View>
        {view.seat === "need" ? (
          <View
            pointerEvents="none"
            style={[
              {
                position: "absolute",
                left: 0,
                top: 0,
                width: size + 4,
                height: size + 4,
                borderRadius: (size + 4) / 2,
                borderWidth: 2,
                borderStyle: "dashed",
                borderColor: SEAT_COLORS.need.ring,
              },
              animate ? anim("crew-spin 6s linear infinite") : null,
            ]}
          />
        ) : null}
      </View>
    </View>
  )
  return box
}
