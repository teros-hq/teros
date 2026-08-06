/**
 * WelcomeSplash — Full-screen cinematic overlay, step 0 only.
 *
 * Rendered OUTSIDE the card (at page level) so it has no clipping or height
 * issues. StyleSheet.absoluteFillObject fills the entire screen.
 *
 * Layers (back → front):
 *   bgLayer   — page fill, fades out during exit
 *   logoLayer — centered logo + title; logo opacity stays 1 throughout exit
 *               so WelcomeStep logo can take over seamlessly
 *
 * Sequence:
 *   0ms         Logo at (posX:150, posY:-100), scale 0.2, opacity 0
 *   0-520ms     opacity 0→1 (slow reveal)
 *   0-1100ms    posX 150→0 (quad), posY -100→0 (cubic), scale 0.2→1
 *   1100-1500ms title fades in
 *   1500-3500ms hold title for 2s
 *   3500-3850ms title fades out
 *   3850-4310ms logo shake + circular sweep (top-right to bottom-left)
 *   4310-5050ms curved shooting-star exit to WelcomeStep handoff position
 *               while scaling logo down to final size
 *   ~5050ms     onDone()
 */

import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { Animated, Easing, StyleSheet, View } from "react-native"
import { Text } from "tamagui"
import { TerosLogo } from "../TerosLogo"
import { colors as semanticColors } from "../mca/primitives/colors"
import { useColors } from "../mca/primitives/useColors"

const LOGO_SIZE = 120

// ── Types ──────────────────────────────────────────────────────────────────────

interface Vals {
  bgOpacity: Animated.Value
  logoScale: Animated.Value
  logoOpacity: Animated.Value
  posX: Animated.Value
  posY: Animated.Value
  titleOpacity: Animated.Value
}

// ── Helper ─────────────────────────────────────────────────────────────────────

function timed(
  v: Animated.Value,
  toValue: number,
  duration: number,
  extra: Partial<Animated.TimingAnimationConfig> = {},
): Animated.CompositeAnimation {
  return Animated.timing(v, { toValue, duration, useNativeDriver: true, ...extra })
}

// ── Animation sequence ─────────────────────────────────────────────────────────

function runAnim(v: Vals, exitPosY: number, onDone: () => void) {
  const shoot = Animated.parallel([
    timed(v.logoOpacity, 1, 520, { easing: Easing.out(Easing.cubic) }),
    timed(v.posX, 0, 980, { easing: Easing.out(Easing.quad) }),
    timed(v.posY, 0, 1100, { easing: Easing.out(Easing.cubic) }),
    timed(v.logoScale, 1, 1050, { easing: Easing.out(Easing.back(1.25)) }),
  ])

  const titleInHoldOut = Animated.sequence([
    timed(v.titleOpacity, 1, 400, { easing: Easing.out(Easing.cubic) }),
    Animated.delay(2000),
    timed(v.titleOpacity, 0, 350, { easing: Easing.in(Easing.cubic) }),
  ])

  const shakeAndSweep = Animated.sequence([
    Animated.parallel([
      timed(v.posX, 34, 220, { easing: Easing.inOut(Easing.sin) }),
      timed(v.posY, -26, 220, { easing: Easing.inOut(Easing.sin) }),
    ]),
  ])

  const exit = Animated.sequence([
    Animated.parallel([
      timed(v.posX, -30, 220, { easing: Easing.inOut(Easing.sin) }),
      timed(v.posY, 28, 220, { easing: Easing.inOut(Easing.sin) }),
      timed(v.logoScale, 0.92, 220, { easing: Easing.inOut(Easing.sin) }),
    ]),
    Animated.parallel([
      timed(v.logoScale, 0.667, 520, { easing: Easing.out(Easing.cubic) }),
      timed(v.posX, 0, 520, { easing: Easing.out(Easing.quad) }),
      timed(v.posY, exitPosY, 520, { easing: Easing.out(Easing.cubic) }),
      timed(v.bgOpacity, 0, 740, { easing: Easing.out(Easing.quad) }),
    ]),
  ])

  Animated.sequence([shoot, titleInHoldOut, shakeAndSweep, exit]).start(({ finished }) => {
    if (finished) onDone()
  })
}

// ── Content ────────────────────────────────────────────────────────────────────

interface ContentProps {
  logoScale: Animated.Value
  logoOpacity: Animated.Value
  posX: Animated.Value
  posY: Animated.Value
  titleOpacity: Animated.Value
}

function SplashContent({ logoScale, logoOpacity, posX, posY, titleOpacity }: ContentProps) {
  const { t } = useTranslation()
  const c = useColors()
  return (
    <View style={styles.contentWrapper}>
      <Animated.View
        style={{
          opacity: logoOpacity,
          backgroundColor: "transparent",
          transform: [{ scale: logoScale }, { translateX: posX }, { translateY: posY }],
        }}
      >
        <TerosLogo size={LOGO_SIZE} color={semanticColors.indigo} animated />
      </Animated.View>

      <Animated.View
        style={{
          opacity: titleOpacity,
          alignItems: "center",
          marginTop: 28,
          paddingHorizontal: 24,
        }}
      >
        <Text
          fontSize={28}
          fontWeight="800"
          color={c.text}
          textAlign="center"
          letterSpacing={-0.5}
        >
          {t('onboarding.welcomeTitle')}
        </Text>
        <Text fontSize={15} color={c.text2} textAlign="center" marginTop={8} lineHeight={22}>
          {t('onboarding.welcomeSubtitle')}
        </Text>
      </Animated.View>
    </View>
  )
}

// ── Export ─────────────────────────────────────────────────────────────────────

interface WelcomeSplashProps {
  onDone: () => void
  exitPosY: number
}

export function WelcomeSplash({ onDone, exitPosY }: WelcomeSplashProps) {
  const c = useColors()
  const bgOpacity = useRef(new Animated.Value(1)).current
  const logoScale = useRef(new Animated.Value(0.2)).current
  const logoOpacity = useRef(new Animated.Value(0)).current
  const posX = useRef(new Animated.Value(150)).current
  const posY = useRef(new Animated.Value(-100)).current
  const titleOpacity = useRef(new Animated.Value(0)).current

  useEffect(() => {
    const vals = { bgOpacity, logoScale, logoOpacity, posX, posY, titleOpacity }
    runAnim(vals, exitPosY, onDone)
  }, [bgOpacity, logoScale, logoOpacity, posX, posY, titleOpacity, exitPosY, onDone])

  return (
    <View style={styles.container}>
      {/* Background — fades independently of the logo */}
      <Animated.View style={[StyleSheet.absoluteFillObject, styles.bg, { opacity: bgOpacity }]} />

      {/* Logo + title — logo opacity stays 1 during exit */}
      <SplashContent
        logoScale={logoScale}
        logoOpacity={logoOpacity}
        posX={posX}
        posY={posY}
        titleOpacity={titleOpacity}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 50,
  },
  bg: {
    backgroundColor: "#000000",
  },
  contentWrapper: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
})
