/**
 * Hero gradient helper (TER-538) — shared by the CatalogDetailWindow and the
 * AppWindow so both heroes look identical.
 *
 * The brand colours are extracted from the MCA icon once at sync
 * (`accentColors`); this is pure *presentation* — it turns those colours into a
 * CSS gradient. With 2-3 colours it builds a multi-colour brand wash (the
 * mockup look); with 0-1 (monochrome logo) it falls back to a single-accent
 * wash derived with `shadeColor`.
 */

/** Lighten (percent>0) or darken (percent<0) a hex colour toward white/black. */
export function shadeColor(hex: string, percent: number): string {
  const h = hex.replace("#", "")
  const full = h.length === 3 ? h.split("").map((ch) => ch + ch).join("") : h
  const num = Number.parseInt(full, 16)
  if (Number.isNaN(num) || full.length !== 6) return hex
  const t = percent < 0 ? 0 : 255
  const p = Math.abs(percent)
  const ch = (shift: number) => {
    const base = (num >> shift) & 0xff
    return Math.round((t - base) * p + base)
  }
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`
}

const HEX6 = /^#[0-9a-fA-F]{6}$/

/**
 * Build the hero `backgroundImage` gradient from the MCA's extracted brand
 * colours, falling back to a single-accent wash when there are fewer than two.
 */
export function gradientFromColors(colors: string[] | undefined, fallbackAccent: string): string {
  const valid = (colors ?? []).filter((c) => HEX6.test(c))
  if (valid.length >= 2) {
    const stops = valid.slice(0, 3)
    const n = stops.length
    const parts = stops.map((c, i) => `${c} ${Math.round((i / (n - 1)) * 65)}%`)
    parts.push(`${shadeColor(stops[n - 1], -0.38)} 100%`)
    return `radial-gradient(135% 130% at 18% 0%, ${parts.join(", ")})`
  }
  const accent = valid[0] ?? fallbackAccent
  return `radial-gradient(130% 120% at 22% 8%, ${shadeColor(accent, 0.3)} 0%, ${accent} 44%, ${shadeColor(accent, -0.42)} 100%)`
}
