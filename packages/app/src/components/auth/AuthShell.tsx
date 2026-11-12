/**
 * AuthShell — the access screens' chrome of the OS prototype (design-testing
 * `.acc`): the page colour with the welcome columns rising and falling behind
 * (web only, `prefers-reduced-motion` aware), and one centred translucent card
 * (radius 24, max 416 — `wide` 480) with a small mono footer.
 *
 *   <AuthShell footer>
 *     <AuthBrand />
 *     <T step="2xl">Entra en Teros</T>
 *     …
 *   </AuthShell>
 *
 * Shared by login / email / signup / welcome / onboarding, the 404 editorial
 * screen and the logout interstitial, so the family cannot drift apart.
 */
import React from "react"
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { useTranslation } from "react-i18next"
import { colors as semantic } from "../mca/primitives/colors"
import { FONT_SANS } from "../mca/primitives/fonts"
import { useColors, useMcaTheme } from "../mca/primitives/useColors"
import { TerosLogo } from "../TerosLogo"
import { AuthColumns } from "./AuthColumns"
import { Ph, T } from "../ui/ds"

// ─── Welcome background (web) ────────────────────────────────────────────────

/** The prototype's column engine behind the card (web only; nothing on native). */
export function DriftBlobs() {
  const c = useColors()
  if (Platform.OS !== "web") return null
  return <AuthColumns background={c.bgPage} />
}

// ─── Shell ───────────────────────────────────────────────────────────────────

export interface AuthShellProps {
  children: React.ReactNode
  /** 480 max-width instead of 416 (the waitlist / onboarding cards). */
  wide?: boolean
  /** Custom max-width (wins over `wide`). */
  maxWidth?: number
  /** Show the "Teros · private alpha · …" mono footer. */
  footer?: boolean
  /** Render the children without the card (the onboarding wizard draws its own). */
  bare?: boolean
  /** Card padding override (default 36 / 36 / 24). */
  pad?: number
  cardStyle?: ViewStyle
  testID?: string
}

export function AuthShell({
  children,
  wide,
  maxWidth,
  footer,
  bare,
  pad,
  cardStyle,
  testID,
}: AuthShellProps) {
  const c = useColors()
  const theme = useMcaTheme()
  const insets = useSafeAreaInsets()
  const { t } = useTranslation()
  const width = maxWidth ?? (wide ? 480 : 416)

  const card = bare ? (
    children
  ) : (
    <View
      testID={testID}
      style={[
        {
          width: "100%",
          maxWidth: width,
          alignSelf: "center",
          borderRadius: 24,
          // The prototype's card is 90 % opaque so the columns show through
          // its edges; native keeps it solid.
          backgroundColor:
            Platform.OS === "web"
              ? theme === "dark"
                ? "rgba(32,28,39,0.9)"
                : "rgba(255,255,255,0.9)"
              : c.bgStep,
          paddingTop: pad ?? 36,
          paddingHorizontal: pad ?? 36,
          paddingBottom: pad ?? 24,
        },
        Platform.OS === "web" ? ({ boxShadow: c.elevRaised } as any) : null,
        cardStyle,
      ]}
    >
      {children}
    </View>
  )

  return (
    <View style={{ flex: 1, backgroundColor: c.bgPage }}>
      <DriftBlobs />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            flexGrow: 1,
            paddingTop: Math.max(48, insets.top + 16),
            paddingBottom: Math.max(24, insets.bottom + 12),
            paddingHorizontal: 16,
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={{ flex: 1, justifyContent: "center" }}>{card}</View>
          {footer ? (
            <View style={styles.footer}>
              <T step="12" tone="text3" center>
                {t("auth.footerNote", {
                  defaultValue:
                    "Teros · private alpha · Your session lasts 30 days in this browser",
                })}
              </T>
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  )
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

/** Logo + wordmark (`.acc-logo`), the same pair the sidebar brand row draws. */
export function AuthBrand({ style }: { style?: ViewStyle }) {
  const c = useColors()
  return (
    <View
      style={[{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 28 }, style]}
    >
      <TerosLogo size={24} animated={false} />
      <Text
        style={{
          fontFamily: FONT_SANS,
          fontSize: 20,
          lineHeight: 22,
          letterSpacing: 0.2,
          color: c.text,
          fontWeight: "400",
        }}
      >
        Teros
      </Text>
    </View>
  )
}

/** Serif title + optional lead (`.acc-t` / `.acc-lead`). */
export function AuthTitle({ title, lead }: { title: string; lead?: string }) {
  return (
    <View>
      <T step="2xl" style={{ fontSize: 32, lineHeight: 36, letterSpacing: -0.48 }}>
        {title}
      </T>
      {lead ? (
        <T step="sm" tone="text2" style={{ marginTop: 10, lineHeight: 19 }}>
          {lead}
        </T>
      ) : null}
    </View>
  )
}

/** Hairline — label — hairline (`.acc-or`). */
export function AuthDivider({ label }: { label: string }) {
  const c = useColors()
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        marginTop: 22,
        marginBottom: 18,
      }}
    >
      <View style={{ flex: 1, height: 1, backgroundColor: c.border }} />
      <T step="xs" tone="text3">
        {label}
      </T>
      <View style={{ flex: 1, height: 1, backgroundColor: c.border }} />
    </View>
  )
}

/** Inline accent link (`.acc-link`). */
export function AuthLink({
  children,
  onPress,
  muted,
  testID,
}: {
  children: React.ReactNode
  onPress?: () => void
  muted?: boolean
  testID?: string
}) {
  const c = useColors()
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="link"
      testID={testID}
      style={({ pressed }) => [
        { opacity: pressed ? 0.7 : 1 },
        Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
      ]}
    >
      <T
        step="sm"
        color={muted ? c.text2 : c.accent}
        style={{
          textDecorationLine: "underline",
          ...(Platform.OS === "web"
            ? ({
                textUnderlineOffset: 3,
                textDecorationColor: muted ? c.borderStrong : "rgba(111,39,255,0.4)",
              } as any)
            : null),
        }}
      >
        {children}
      </T>
    </Pressable>
  )
}

/** Red / neutral banner (`.acc-banner`, `.acc-banner.lock`). */
export function AuthBanner({
  icon,
  children,
  tone = "r",
  testID,
}: {
  icon?: string
  children: React.ReactNode
  tone?: "r" | "lock" | "a"
  testID?: string
}) {
  const c = useColors()
  const lock = tone === "lock"
  const tint = tone === "a" ? c.tint.a : c.tint.r
  return (
    <View
      testID={testID}
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
        padding: 12,
        paddingHorizontal: 14,
        borderRadius: 10,
        backgroundColor: lock ? c.wash : tint.bg,
        borderWidth: 1,
        borderColor: lock ? c.borderStrong : tint.bd,
        marginBottom: 16,
      }}
    >
      {icon ? (
        <Ph name={icon} size={18} color={lock ? c.accent : tint.tx} style={{ marginTop: 1 }} />
      ) : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        {typeof children === "string" ? (
          <T step="sm" color={lock ? c.text : tint.tx}>
            {children}
          </T>
        ) : (
          children
        )}
      </View>
    </View>
  )
}

/** The help line (`.acc-help`): small glyph + 12px text2. */
export function AuthHelp({
  icon = "lifebuoy",
  children,
}: {
  icon?: string
  children: React.ReactNode
}) {
  const c = useColors()
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, marginTop: 20 }}>
      <Ph name={icon} size={15} color={c.text3} style={{ marginTop: 1 }} />
      <View style={{ flex: 1, minWidth: 0 }}>{children}</View>
    </View>
  )
}

/** The "¿No tienes cuenta? Crear cuenta" row under a hairline (`.acc-switch`). */
export function AuthSwitch({
  question,
  action,
  onPress,
  testID,
}: {
  question: string
  action: string
  onPress: () => void
  testID?: string
}) {
  const c = useColors()
  return (
    <View
      style={{
        borderTopWidth: 1,
        borderTopColor: c.border,
        marginTop: 14,
        paddingTop: 16,
        flexDirection: "row",
        justifyContent: "center",
        alignItems: "center",
        gap: 6,
        flexWrap: "wrap",
      }}
    >
      <T step="sm" tone="text2">
        {question}
      </T>
      <AuthLink onPress={onPress} testID={testID}>
        {action}
      </AuthLink>
    </View>
  )
}

/** Half-width provider button of the prototype (`.acc-pbtn`): 44px, radius 10. */
export function ProviderBtn({
  icon,
  label,
  onPress,
  soon,
  testID,
  full,
}: {
  icon: React.ReactNode
  label: string
  onPress?: () => void
  soon?: boolean
  testID?: string
  full?: boolean
}) {
  const c = useColors()
  const [hover, setHover] = React.useState(false)
  const { t } = useTranslation()
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={soon}
      testID={testID}
      {...(Platform.OS === "web"
        ? { onHoverIn: () => setHover(true), onHoverOut: () => setHover(false) }
        : {})}
      style={({ pressed }) => [
        {
          flex: full ? undefined : 1,
          alignSelf: full ? "stretch" : undefined,
          height: 44,
          minWidth: 0,
          paddingHorizontal: 14,
          borderRadius: 10,
          borderWidth: 1,
          borderStyle: soon ? "dashed" : "solid",
          borderColor: soon ? c.borderStrong : hover ? semantic.main500 : c.borderStrong,
          backgroundColor: soon ? "transparent" : hover ? c.wash : c.bgStep,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: soon ? 8 : 10,
          transform: pressed ? [{ scale: 0.98 }] : undefined,
        },
        Platform.OS === "web"
          ? ({
              cursor: soon ? "not-allowed" : "pointer",
              transition: "background 0.2s, border-color 0.2s",
            } as any)
          : null,
      ]}
    >
      {icon}
      <T
        step={soon ? "sm" : "base"}
        color={soon ? c.text3 : c.text}
        numberOfLines={1}
        style={soon ? null : { fontSize: 14 }}
      >
        {label}
      </T>
      {soon ? (
        <View
          style={{
            backgroundColor: c.wash2,
            borderRadius: 5,
            paddingHorizontal: 6,
            paddingVertical: 4,
          }}
        >
          <T step="xxs" tone="text3" style={{ letterSpacing: 1.3 }}>
            {t("common.soon")}
          </T>
        </View>
      ) : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  footer: {
    paddingTop: 20,
    paddingHorizontal: 16,
    alignItems: "center",
  },
})
