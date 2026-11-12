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
 * Sequence (ONB-REQ-11: at most 1 500 ms, ends on any click, tap or key):
 *   0-500ms     logo shoots in: opacity 0→1, (150,-100)→(0,0), scale 0.2→1
 *   500-700ms   title fades in
 *   700-900ms   hold
 *   900-1400ms  title out, logo glides to the WelcomeStep handoff position,
 *               background fades
 *   1400ms      onDone()
 */

import { useCallback, useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { Animated, Easing, Platform, Pressable, StyleSheet, View } from "react-native"
import { TerosLogo } from "../TerosLogo"
import { useColors } from "../mca/primitives/useColors"
import { T } from "../ui/ds"

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

/** Phase durations (ms). Their sum is the splash length — ONB-REQ-11 caps it at 1 500. */
export const SPLASH_PHASES = { shoot: 500, titleIn: 200, hold: 200, exit: 500 } as const
export const SPLASH_DURATION_MS =
  SPLASH_PHASES.shoot + SPLASH_PHASES.titleIn + SPLASH_PHASES.hold + SPLASH_PHASES.exit

function runAnim(v: Vals, exitPosY: number, onDone: () => void): Animated.CompositeAnimation {
  const P = SPLASH_PHASES
  const shoot = Animated.parallel([
    timed(v.logoOpacity, 1, 300, { easing: Easing.out(Easing.cubic) }),
    timed(v.posX, 0, P.shoot, { easing: Easing.out(Easing.quad) }),
    timed(v.posY, 0, P.shoot, { easing: Easing.out(Easing.cubic) }),
    timed(v.logoScale, 1, P.shoot, { easing: Easing.out(Easing.back(1.25)) }),
  ])
  const title = Animated.sequence([
    timed(v.titleOpacity, 1, P.titleIn, { easing: Easing.out(Easing.cubic) }),
    Animated.delay(P.hold),
  ])
  const exit = Animated.parallel([
    timed(v.titleOpacity, 0, 200, { easing: Easing.in(Easing.cubic) }),
    timed(v.logoScale, 0.667, P.exit, { easing: Easing.out(Easing.cubic) }),
    timed(v.posY, exitPosY, P.exit, { easing: Easing.out(Easing.cubic) }),
    timed(v.bgOpacity, 0, P.exit, { easing: Easing.out(Easing.quad) }),
  ])
  const anim = Animated.sequence([shoot, title, exit])
  anim.start(({ finished }) => {
    if (finished) onDone()
  })
  return anim
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
        <TerosLogo size={LOGO_SIZE} color={c.accent} animated />
      </Animated.View>

      <Animated.View
        style={{
          opacity: titleOpacity,
          alignItems: "center",
          marginTop: 28,
          paddingHorizontal: 24,
        }}
      >
        <T step="2xl" center>
          {t("onboarding.welcomeTitle")}
        </T>
        <T step="base" tone="text2" center style={{ marginTop: 8 }}>
          {t("onboarding.welcomeSubtitle")}
        </T>
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

  // ONB-REQ-11: any click, tap or key ends the splash at once (onDone fires once).
  const finished = useRef(false)
  const animRef = useRef<Animated.CompositeAnimation | null>(null)
  const finish = useCallback(() => {
    if (finished.current) return
    finished.current = true
    animRef.current?.stop()
    onDone()
  }, [onDone])

  useEffect(() => {
    const vals = { bgOpacity, logoScale, logoOpacity, posX, posY, titleOpacity }
    animRef.current = runAnim(vals, exitPosY, finish)
    if (Platform.OS !== "web" || typeof window === "undefined") return
    window.addEventListener("keydown", finish)
    return () => window.removeEventListener("keydown", finish)
  }, [bgOpacity, logoScale, logoOpacity, posX, posY, titleOpacity, exitPosY, finish])

  return (
    <Pressable style={styles.container} onPress={finish} accessibilityRole="button" testID="welcome-splash">
      {/* Background — fades independently of the logo */}
      <Animated.View
        style={[StyleSheet.absoluteFillObject, { backgroundColor: c.bgFrame, opacity: bgOpacity }]}
      />

      {/* Logo + title — logo opacity stays 1 during exit */}
      <SplashContent
        logoScale={logoScale}
        logoOpacity={logoOpacity}
        posX={posX}
        posY={posY}
        titleOpacity={titleOpacity}
      />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 50,
  },
  contentWrapper: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
})
