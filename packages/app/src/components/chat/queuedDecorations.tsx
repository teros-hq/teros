import type React from "react"
import { Platform, View } from "react-native"
import { useColors } from "../mca/primitives/useColors"
import { colors as semanticColors, surface } from "../mca/primitives/colors"
import { useTranslation } from "react-i18next"
import { Ph, T } from "../ui/ds"
import { installShimmerKeyframes } from "./shimmerKeyframes"

installShimmerKeyframes()

/**
 * Overlay con linear-gradient + translateX que crea el shimmer skeleton.
 * Pensado para ir como primer hijo de un contenedor con `position: relative`
 * y `overflow: hidden`. Sólo web; nativo cae a un overlay estático tenue
 * (el color de la onda al 15% de alpha).
 *
 * Los colores del gradiente y del fallback nativo se adaptan al tema activo
 * usando `useColors()` y los ramps del DS (v0.2.6) — sin hex inventados.
 * Bug 2026-10-05: en light la onda accent usaba Purple/100, prácticamente
 * el mismo color que el tinte de la burbuja (≈1:1) — animaba pero era
 * invisible. Purple/200 lo arregló pero Pablo la encontró demasiado
 * agresiva (2026-10-06) — la onda accent es ahora un sheen BLANCO
 * translúcido (45% alpha) en AMBOS temas: visible pero suave, y el
 * blanco nunca pelea con la legibilidad del texto bajo la banda.
 */
export function QueuedShimmer({
  tone = "neutral",
}: {
  /**
   * 'neutral' (default): the theme's strong-border gray in dark (Main/600),
   * one step deeper in light (Main/500) — for neutral surfaces (media
   * bubbles, cross-channel messages).
   * 'accent': a violet one step lighter than the own bubble's fill
   * (Purple/200 over Purple/300 in BOTH themes) — for queued bubbles that
   * still ride the violet fill, so the wave reads as a violet sheen.
   * 'mint': the OS prototype's `.msg.user.queued` wave — Mint/100 → Main/300
   * → Mint/100 over the mint glow of the user bubble.
   */
  tone?: "neutral" | "accent" | "mint"
}): React.ReactElement {
  const c = useColors()
  const isDark = c.bgPage === surface.dark.bgPage

  // Wave color (DS v0.2.6 ramps, contrast measured on the surfaces it rides):
  // - accent: a translucent sheen (Pablo, 2026-10-06 — three passes). Light
  //   keeps the white 45% wash he validated; dark takes a whisper of PALE
  //   LAVENDER — Purple/100 at 12%.
  // - neutral: the theme's strong-border gray in dark (Main/600, 3.29:1 on
  //   bgInner); one step deeper in light (Main/500, 2.84:1).
  // - mint: Main/300 (light) / the mint tint border (dark) riding the glow.
  const ACCENT_SHEEN = isDark
    ? "rgba(231, 220, 255, 0.12)" // Purple/100 #E7DCFF at 12% — Pablo picked D4 from the intensity widget
    : "rgba(255, 255, 255, 0.45)"
  const shimmerColor =
    tone === "accent"
      ? ACCENT_SHEEN
      : tone === "mint"
        ? isDark
          ? c.tint.m.bd
          : semanticColors.main300
        : isDark
          ? c.borderStrong
          : semanticColors.main500

  const webStyle =
    Platform.OS === "web"
      ? ({
          background: `linear-gradient(90deg, transparent 0%, ${shimmerColor} 50%, transparent 100%)`,
          animation: "message-queue-shimmer 1.8s linear infinite",
          opacity: tone === "mint" ? 0.8 : 1,
        } as object)
      : // Native: no keyframes path — a faint static wash of the same wave
        // color (15% alpha) so the queued state still tints the bubble in
        // both themes.
        {
          backgroundColor:
            tone === "accent"
              ? isDark
                ? "rgba(231, 220, 255, 0.12)"
                : "rgba(255, 255, 255, 0.15)"
              : `${shimmerColor}26`,
        }

  return (
    <View
      pointerEvents="none"
      testID="queued-shimmer"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        ...webStyle,
      }}
    />
  )
}

/** "Queued" mark — codenote in the accent with a clock glyph (`.msg.user.queued .time`). */
export function QueuedIndicator({ color }: { color?: string }): React.ReactElement {
  const { t } = useTranslation()
  const c = useColors()

  // The theme's accent SURFACE role (R10): Purple/200 in dark, Purple/300
  // in light — 4.83:1 on the light bubble tint and 5.65:1 on light sheets.
  const effectiveColor = color ?? c.accent

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <Ph name="clock" size={11} color={effectiveColor} />
      <T step="codenote" color={effectiveColor}>
        {t("chat.queued")}
      </T>
    </View>
  )
}
