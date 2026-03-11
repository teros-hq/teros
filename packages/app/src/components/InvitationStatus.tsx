import { Check, Crown, Info, Star, User } from "@tamagui/lucide-icons"
import React, { useState } from "react"
import { Animated, Image, type LayoutChangeEvent } from "react-native"
import Svg, { Circle, Defs, Line, LinearGradient, Path, Stop } from "react-native-svg"
import { Text, View, XStack, YStack } from "tamagui"
import { useInvitations } from "../hooks/useInvitations"
import { usePulseAnimation } from "../hooks/usePulseAnimation"
import type { TerosClient } from "../services/TerosClient"

interface InvitationStatusProps {
  client: TerosClient | null
}

// Puzzle piece paths for the 3 sectors
const PUZZLE_PATHS = {
  piece1: "M50,50 L50,12 A38,38 0 0,1 82.9,69 Z", // top-right
  piece2: "M50,50 L82.9,69 A38,38 0 0,1 17.1,69 Z", // bottom
  piece3: "M50,50 L17.1,69 A38,38 0 0,1 50,12 Z", // top-left
}

const PIECE_COLORS = {
  piece1: { start: "#06B6D4", end: "#0891B2", glow: "rgba(6, 182, 212, 0.4)" },
  piece2: { start: "#8B5CF6", end: "#7C3AED", glow: "rgba(139, 92, 246, 0.4)" },
  piece3: { start: "#EC4899", end: "#DB2777", glow: "rgba(236, 72, 153, 0.4)" },
}

// Animated pulsing dot component using React Native's Animated API
const PulsingDot = ({ color }: { color: string }) => {
  const opacity = usePulseAnimation(true, { minOpacity: 0.4, duration: 1000 })

  return (
    <Animated.View
      style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: color,
        opacity,
      }}
    />
  )
}

// Puzzle piece SVG for cards
const PuzzlePieceIcon = ({
  path,
  color,
  active,
}: {
  path: string
  color: string
  active: boolean
}) => (
  <Svg width={22} height={22} viewBox="0 0 100 100">
    <Path d={path} fill={active ? color : "#3F3F46"} opacity={active ? 1 : 0.5} />
  </Svg>
)

// Breakpoint for switching between horizontal and vertical layout
const COMPACT_BREAKPOINT = 400

export const InvitationStatus: React.FC<InvitationStatusProps> = ({ client }) => {
  const { status, loading, loadStatus } = useInvitations(client)
  const [containerWidth, setContainerWidth] = useState(0)
  const isCompact = containerWidth > 0 && containerWidth < COMPACT_BREAKPOINT

  const handleLayout = (event: LayoutChangeEvent) => {
    setContainerWidth(event.nativeEvent.layout.width)
  }

  React.useEffect(() => {
    if (client && client.isConnected()) {
      loadStatus()
    }
  }, [client])

  if (loading && !status) {
    return (
      <YStack padding="$4" alignItems="center">
        <Text color="$gray11">Loading invitation status...</Text>
      </YStack>
    )
  }

  if (!status) {
    return null
  }

  const hasAccess = status.accessGranted
  const received = status.received
  const required = status.required
  const remaining = required - received

  // VIP access: has access but doesn't have all 3 invitations
  const isVipAccess = hasAccess && received < required

  // Map invitations to pieces
  const pieces = [
    {
      id: "piece1",
      ...PIECE_COLORS.piece1,
      path: PUZZLE_PATHS.piece1,
      invitation: status.invitations[0],
    },
    {
      id: "piece2",
      ...PIECE_COLORS.piece2,
      path: PUZZLE_PATHS.piece2,
      invitation: status.invitations[1],
    },
    {
      id: "piece3",
      ...PIECE_COLORS.piece3,
      path: PUZZLE_PATHS.piece3,
      invitation: status.invitations[2],
    },
  ]

  const getStatusTitle = () => {
    if (isVipAccess) return "VIP Access"
    if (hasAccess) return "Full Access!"
    if (received === 0) return "Start your puzzle"
    if (received === 1) return "Good start"
    if (received === 2) return "Almost there"
    return "In progress"
  }

  const getStatusSubtitle = () => {
    if (isVipAccess) return "You have special access to TEROS"
    if (hasAccess) return "You have completed the access puzzle"
    if (received === 0) return `You need ${required} invitations to get access`
    return `You need ${remaining} more piece${remaining > 1 ? "s" : ""} to complete access`
  }

  // VIP users get a simple horizontal badge
  if (isVipAccess) {
    return (
      <YStack
        margin="$4"
        borderRadius={20}
        padding="$5"
        borderWidth={1}
        borderColor="rgba(212, 175, 55, 0.3)"
        backgroundColor="rgba(212, 175, 55, 0.05)"
        gap="$4"
        alignItems="center"
        onLayout={handleLayout}
        {...(!isCompact &&
          containerWidth > 0 && {
            flexDirection: "row",
            gap: "$5",
          })}
      >
        {/* Hamster Image with Golden Ring */}
        <View width={120} height={120} position="relative" flexShrink={0}>
          {/* Golden ring */}
          <Svg width={120} height={120} viewBox="0 0 120 120" style={{ position: "absolute" }}>
            <Defs>
              <LinearGradient id="vipRingGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <Stop offset="0%" stopColor="#D4AF37" />
                <Stop offset="25%" stopColor="#F4E4A6" />
                <Stop offset="50%" stopColor="#D4AF37" />
                <Stop offset="75%" stopColor="#B8962E" />
                <Stop offset="100%" stopColor="#D4AF37" />
              </LinearGradient>
            </Defs>
            <Circle cx="60" cy="60" r="56" fill="none" stroke="url(#vipRingGrad)" strokeWidth={4} />
          </Svg>

          {/* Hamster image */}
          <View
            position="absolute"
            top={10}
            left={10}
            width={100}
            height={100}
            borderRadius={50}
            overflow="hidden"
          >
            <Image
              source={{
                uri: `${process.env.EXPO_PUBLIC_BACKEND_URL}/static/badges/kawaii-v1/09-hamster-vip.webp`,
              }}
              style={{
                width: 100,
                height: 100,
                borderRadius: 50,
              }}
              resizeMode="cover"
            />
          </View>
        </View>

        {/* Info Section */}
        <YStack flex={1} gap="$3" alignItems={isCompact ? "center" : "flex-start"}>
          {/* Title with crown */}
          <XStack alignItems="center" gap="$2">
            <Crown size={22} color="#FBBF24" />
            <Text fontSize={20} fontWeight="700" color="#FBBF24" letterSpacing={2}>
              ACCESO VIP
            </Text>
          </XStack>

          {/* Description */}
          <YStack alignItems={isCompact ? "center" : "flex-start"}>
            <Text
              fontSize={14}
              color="#A1A1AA"
              lineHeight={21}
              textAlign={isCompact ? "center" : "left"}
            >
              Tienes acceso especial a TEROS.
            </Text>
            <Text
              fontSize={14}
              color="#A1A1AA"
              lineHeight={21}
              textAlign={isCompact ? "center" : "left"}
            >
              No necesitas invitaciones adicionales.
            </Text>
          </YStack>
        </YStack>
      </YStack>
    )
  }

  return (
    <YStack padding="$4" gap="$6">
      {/* Header with Puzzle Circle */}
      <YStack alignItems="center" gap="$4" paddingTop="$4">
        {/* Puzzle Circle */}
        <View width={180} height={180} position="relative">
          <Svg width={180} height={180} viewBox="0 0 100 100">
            <Defs>
              <LinearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="100%">
                <Stop offset="0%" stopColor={PIECE_COLORS.piece1.start} />
                <Stop offset="100%" stopColor={PIECE_COLORS.piece1.end} />
              </LinearGradient>
              <LinearGradient id="grad2" x1="0%" y1="0%" x2="100%" y2="100%">
                <Stop offset="0%" stopColor={PIECE_COLORS.piece2.start} />
                <Stop offset="100%" stopColor={PIECE_COLORS.piece2.end} />
              </LinearGradient>
              <LinearGradient id="grad3" x1="0%" y1="0%" x2="100%" y2="100%">
                <Stop offset="0%" stopColor={PIECE_COLORS.piece3.start} />
                <Stop offset="100%" stopColor={PIECE_COLORS.piece3.end} />
              </LinearGradient>
            </Defs>

            {/* Piece 1 */}
            <Path
              d={PUZZLE_PATHS.piece1}
              fill={received >= 1 ? "url(#grad1)" : "rgba(255, 255, 255, 0.03)"}
              stroke={received >= 1 ? "none" : "rgba(255, 255, 255, 0.08)"}
              strokeWidth={1.5}
            />

            {/* Piece 2 */}
            <Path
              d={PUZZLE_PATHS.piece2}
              fill={received >= 2 ? "url(#grad2)" : "rgba(255, 255, 255, 0.03)"}
              stroke={received >= 2 ? "none" : "rgba(255, 255, 255, 0.08)"}
              strokeWidth={1.5}
            />

            {/* Piece 3 */}
            <Path
              d={PUZZLE_PATHS.piece3}
              fill={received >= 3 ? "url(#grad3)" : "rgba(255, 255, 255, 0.03)"}
              stroke={received >= 3 ? "none" : "rgba(255, 255, 255, 0.08)"}
              strokeWidth={1.5}
            />

            {/* Separator lines */}
            <Line x1="50" y1="50" x2="50" y2="12" stroke="#09090b" strokeWidth={4} />
            <Line x1="50" y1="50" x2="82.9" y2="69" stroke="#09090b" strokeWidth={4} />
            <Line x1="50" y1="50" x2="17.1" y2="69" stroke="#09090b" strokeWidth={4} />
          </Svg>

          {/* Center circle */}
          <View
            position="absolute"
            top="50%"
            left="50%"
            width={70}
            height={70}
            marginLeft={-35}
            marginTop={-35}
            backgroundColor="#09090b"
            borderRadius={35}
            borderWidth={2}
            borderColor="rgba(255, 255, 255, 0.08)"
            alignItems="center"
            justifyContent="center"
          >
            <Text fontSize={28} fontWeight="700" color="#06B6D4">
              {received}
            </Text>
            <Text fontSize={11} color="#52525B" textTransform="uppercase" letterSpacing={1.5}>
              de {required}
            </Text>
          </View>
        </View>

        {/* Status text */}
        <YStack alignItems="center" gap="$2">
          <Text fontSize={24} fontWeight="600" color="$color" letterSpacing={-0.5}>
            {getStatusTitle()}
          </Text>
          <Text fontSize={14} color="#71717A">
            {getStatusSubtitle()}
          </Text>
        </YStack>

        {/* Access badge */}
        <XStack
          alignItems="center"
          gap="$2"
          paddingHorizontal="$4"
          paddingVertical="$2"
          backgroundColor={hasAccess ? "rgba(16, 185, 129, 0.1)" : "rgba(245, 158, 11, 0.1)"}
          borderWidth={1}
          borderColor={hasAccess ? "rgba(16, 185, 129, 0.25)" : "rgba(245, 158, 11, 0.25)"}
          borderRadius={100}
        >
          {hasAccess ? <Check size={14} color="#10B981" /> : <PulsingDot color="#F59E0B" />}
          <Text
            fontSize={12}
            fontWeight="600"
            color={hasAccess ? "#10B981" : "#F59E0B"}
            textTransform="uppercase"
            letterSpacing={0.5}
          >
            {hasAccess ? "Access Granted" : "Access Pending"}
          </Text>
        </XStack>
      </YStack>

      {/* Puzzle pieces list */}
      <YStack gap="$3">
        <Text
          fontSize={12}
          color="#52525B"
          textTransform="uppercase"
          letterSpacing={1.5}
          fontWeight="500"
        >
          Tus piezas del puzzle
        </Text>

        <YStack gap="$2">
          {pieces.map((piece, index) => {
            const isActive = index < received
            const invitation = piece.invitation

            return (
              <XStack
                key={piece.id}
                alignItems="center"
                gap="$3"
                padding="$3"
                paddingHorizontal="$4"
                borderRadius={14}
                backgroundColor={
                  isActive
                    ? `rgba(${piece.id === "piece1" ? "6, 182, 212" : piece.id === "piece2" ? "139, 92, 246" : "236, 72, 153"}, 0.06)`
                    : "rgba(255, 255, 255, 0.015)"
                }
                borderWidth={1}
                borderColor={
                  isActive
                    ? `rgba(${piece.id === "piece1" ? "6, 182, 212" : piece.id === "piece2" ? "139, 92, 246" : "236, 72, 153"}, 0.12)`
                    : "rgba(255, 255, 255, 0.08)"
                }
                borderStyle={isActive ? "solid" : "dashed"}
              >
                {/* Piece icon */}
                <View
                  width={44}
                  height={44}
                  borderRadius={12}
                  backgroundColor={
                    isActive
                      ? `rgba(${piece.id === "piece1" ? "6, 182, 212" : piece.id === "piece2" ? "139, 92, 246" : "236, 72, 153"}, 0.15)`
                      : "rgba(255, 255, 255, 0.03)"
                  }
                  alignItems="center"
                  justifyContent="center"
                >
                  <PuzzlePieceIcon path={piece.path} color={piece.start} active={isActive} />
                </View>

                {/* Info */}
                <YStack flex={1}>
                  <Text fontSize={15} fontWeight="500" color={isActive ? "$color" : "#52525B"}>
                    {invitation?.sender?.displayName ||
                      (isActive ? "User" : "Waiting for invitation...")}
                  </Text>
                  <Text fontSize={13} color={isActive ? "#71717A" : "#3F3F46"}>
                    {invitation?.sender?.email ||
                      invitation?.fromUserId ||
                      "Ask someone to invite you"}
                  </Text>
                </YStack>

                {/* Check mark */}
                {isActive && <Check size={20} color="#10B981" strokeWidth={2.5} />}
              </XStack>
            )
          })}
        </YStack>
      </YStack>

      {/* Info box */}
      <XStack
        backgroundColor="rgba(255, 255, 255, 0.02)"
        borderWidth={1}
        borderColor="rgba(255, 255, 255, 0.06)"
        borderRadius={12}
        padding="$4"
        gap="$3"
        alignItems="flex-start"
      >
        <Info size={20} color="#52525B" />
        <Text fontSize={13} color="#71717A" lineHeight={20} flex={1}>
          <Text fontWeight="500" color="#A1A1AA">
            Complete the puzzle
          </Text>{" "}
          — You need {required} different users to invite you to unlock full access to{" "}
          <Text fontWeight="600" color="#06B6D4">
            TEROS
          </Text>
          .
        </Text>
      </XStack>
    </YStack>
  )
}
