import { AlertTriangle, CheckCircle2, Clock, Loader2, XCircle } from "@tamagui/lucide-icons"
import { statusMeta, type StatusMeta } from "./colors"

const ICONS = {
  "check-circle": CheckCircle2,
  alert: AlertTriangle,
  "x-circle": XCircle,
  loader: Loader2,
  clock: Clock,
} as const

/**
 * Status icon in its semantic color — the icon+color pairing that keeps status
 * legible without relying on color alone. Pass a raw status string; the meta
 * (color + icon) is resolved from the design's `statusMeta`.
 */
export function StatusDot({ status, size = 15 }: { status: string; size?: number }) {
  const m: StatusMeta = statusMeta(status)
  const Icon = ICONS[m.icon]
  return <Icon size={size} color={m.color} />
}
