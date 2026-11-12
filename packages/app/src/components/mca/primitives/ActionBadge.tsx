import {
  Archive,
  ArrowDownToLine,
  Ban,
  Check,
  Edit3,
  Link2,
  Link2Off,
  Pencil,
  Power,
  PowerOff,
  Trash2,
  UserMinus,
  UserPlus,
} from "./icons"
import type React from "react"
import { Badge, type BadgeVariant, useBadgeColor } from "./Badge"

/**
 * Verbos canónicos de acción soportados. Cubren el catálogo de operaciones
 * CRUD + access control que se repite entre MCAs. Nuevos verbos se añaden a
 * la tabla `VERB_STYLE` de abajo; sin fallback silencioso — un verbo fuera
 * de la tabla se pinta como 'gray' con el texto literal.
 */
export type ActionVerb =
  | "created"
  | "updated"
  | "deleted"
  | "archived"
  | "renamed"
  | "installed"
  | "uninstalled"
  | "granted"
  | "revoked"
  | "added"
  | "removed"
  | "enabled"
  | "disabled"

interface ActionBadgeProps {
  verb: ActionVerb
  size?: "sm" | "md"
}

interface VerbStyle {
  text: string
  variant: BadgeVariant
  Icon: React.ComponentType<{ size?: number; color?: string }>
}

const VERB_STYLE: Record<ActionVerb, VerbStyle> = {
  // positive (creation / link / enablement)
  created: { text: "created", variant: "success", Icon: Check },
  installed: { text: "installed", variant: "success", Icon: ArrowDownToLine },
  granted: { text: "granted", variant: "success", Icon: Link2 },
  added: { text: "added", variant: "success", Icon: UserPlus },
  enabled: { text: "enabled", variant: "info", Icon: Power },

  // mutation
  updated: { text: "updated", variant: "warning", Icon: Edit3 },
  renamed: { text: "renamed", variant: "warning", Icon: Pencil },

  // destructive
  deleted: { text: "deleted", variant: "error", Icon: Trash2 },
  uninstalled: { text: "uninstalled", variant: "error", Icon: Ban },
  revoked: { text: "revoked", variant: "error", Icon: Link2Off },
  removed: { text: "removed", variant: "error", Icon: UserMinus },

  // inert / paused
  archived: { text: "archived", variant: "gray", Icon: Archive },
  disabled: { text: "disabled", variant: "gray", Icon: PowerOff },
}

/**
 * Badge semántica para el verbo de una acción ejecutada (create/update/
 * delete/grant/revoke/…). Combina icono + texto + color para codificar
 * triple la naturaleza de la acción:
 *   - color     → polaridad (verde=positiva, amber=mutación, rojo=destructiva, gris=inerte)
 *   - icono     → tipo específico (link, trash, power, pencil, …)
 *   - texto     → verbo literal
 *
 * Usage:
 *   <ActionBadge verb="created" />
 *   <ActionBadge verb="archived" size="md" />
 */
export function ActionBadge({ verb, size = "sm" }: ActionBadgeProps) {
  const style = VERB_STYLE[verb]
  const fg = useBadgeColor(style.variant)
  const { Icon } = style
  return (
    <Badge
      text={style.text}
      variant={style.variant}
      cap
      icon={<Icon size={size === "md" ? 12 : 10} color={fg} />}
    />
  )
}
