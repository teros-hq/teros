import { Ph } from "../ui/ds/Icon"
import { statusMeta, type StatusMeta } from "./colors"

/** Phosphor glyph per `statusMeta().icon` — the icon+colour pairing that keeps status legible. */
const ICONS: Record<StatusMeta["icon"], string> = {
  "check-circle": "check-circle",
  alert: "warning",
  "x-circle": "x-circle",
  loader: "circle-notch",
  clock: "clock",
}

/**
 * Status icon in its semantic color — the icon+color pairing that keeps status
 * legible without relying on color alone. Pass a raw status string; the meta
 * (color + icon) is resolved from the design's `statusMeta`.
 */
export function StatusDot({ status, size = 15 }: { status: string; size?: number }) {
  const m: StatusMeta = statusMeta(status)
  return <Ph name={ICONS[m.icon]} size={size} color={m.color} />
}
