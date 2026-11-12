/**
 * Pin model — pure helpers over a navbar pin and the window registry.
 * A pin is a serialized window; everything the rail needs to show or open it
 * comes from the window's definition (title, icon, audience, deserialize).
 *
 * @spec NAV-REQ-2, NAV-REQ-8, NAV-REQ-9
 */
import type { TFunction } from "i18next"
import type { ComponentType } from "react"
import { windowRegistry, type WindowTypeDefinition, type WindowWidgetProps } from "../../services/windowRegistry"
import { getResolvedFlag, useFeatureFlagsStore } from "../../store/featureFlagsStore"
import type { NavbarPinData, NavbarPinScope, NavbarPinWindow } from "../../services/NavbarApi"

export type { NavbarPinData, NavbarPinScope, NavbarPinWindow }

/** Not a registry window (`workspace` is the settings window): a pin that switches workspace. @spec NAV-REQ-5 */
export const WORKSPACE_LINK = "workspace-link"

function definitionOf(type: string): WindowTypeDefinition<any> | undefined {
  return windowRegistry.has(type) ? windowRegistry.get(type) : undefined
}

/** Same identity rule as the backend: type + sorted serialized props. @spec NAV-REQ-6 */
export function windowKey(type: string, props: Record<string, any> | undefined): string {
  const p = props ?? {}
  const sorted = Object.keys(p)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      if (p[k] !== undefined) acc[k] = p[k]
      return acc
    }, {})
  return `${type}:${JSON.stringify(sorted)}`
}

/** Serialize a live window's props through its definition (what gets stored). */
export function serializeWindowProps(type: string, props: Record<string, any>): Record<string, any> {
  const def = definitionOf(type)
  if (!def?.serialize) return props ?? {}
  try {
    return (def.serialize(props) as Record<string, any>) ?? {}
  } catch {
    return props ?? {}
  }
}

/** Props to pass to openWindow: the stored props through `deserialize`. @spec NAV-REQ-9 */
/** The rail widget of a window type, if it declares one. @spec NAV-REQ-20 */
export function widgetOf(type: string): ComponentType<WindowWidgetProps<any>> | undefined {
  return definitionOf(type)?.widget
}

/** @spec NAV-REQ-20 */
export function hasWidget(pin: Pick<NavbarPinData, "window">): boolean {
  return !!widgetOf(pin.window.type)
}

/**
 * The props a global pin opens with in the active workspace, or null when the
 * window cannot be global (bound to a workspace entity, or never portable).
 * @spec NAV-REQ-21
 */
export function portableProps(pin: Pick<NavbarPinData, "window">): Record<string, any> | null {
  const def = definitionOf(pin.window.type)
  if (!def?.portable) return null
  try {
    const props = def.deserialize ? def.deserialize(pin.window.props ?? {}) : (pin.window.props ?? {})
    return def.portable(props) ?? null
  } catch {
    return null
  }
}

/** @spec NAV-REQ-21 */
export function isPortable(pin: Pick<NavbarPinData, "window">): boolean {
  return portableProps(pin) !== null
}

export function openProps(pin: Pick<NavbarPinData, "window"> & { global?: boolean }): Record<string, any> {
  if (pin.global) {
    // A global pin re-binds to the active workspace (NAV-REQ-21).
    const portable = portableProps(pin)
    if (portable) return portable
  }
  const def = definitionOf(pin.window.type)
  if (!def?.deserialize) return pin.window.props ?? {}
  try {
    return def.deserialize(pin.window.props ?? {}) ?? {}
  } catch {
    return pin.window.props ?? {}
  }
}

/** The label the rail shows: explicit label → i18n key (factory) → the window's own title. */
export function pinLabel(pin: Pick<NavbarPinData, "label" | "labelKey" | "window">, t: TFunction): string {
  if (pin.label) return pin.label
  if (pin.labelKey) return t(pin.labelKey)
  const def = definitionOf(pin.window.type)
  if (def) {
    try {
      const title = def.getTitle(openProps(pin))
      if (title) return title
    } catch {
      /* fall through */
    }
  }
  return pin.window.type
}

/** Phosphor icon name: explicit → the definition's `phIcon` → a generic window. */
export function pinIcon(pin: Pick<NavbarPinData, "icon" | "window">): string {
  if (pin.icon) return pin.icon
  if (pin.window.type === WORKSPACE_LINK) return "squares-four"
  return definitionOf(pin.window.type)?.phIcon ?? "browser"
}

/**
 * A pin is hidden (never deleted) when its window does not exist in the
 * registry or the viewer may not open it (audience / flag). @spec NAV-REQ-8
 */
export function isPinVisible(pin: Pick<NavbarPinData, "window">): boolean {
  if (pin.window.type === WORKSPACE_LINK) return true
  const def = definitionOf(pin.window.type)
  if (!def) return false
  if (!windowRegistry.canOpen(def)) return false
  const flag = (def as { featureFlag?: string }).featureFlag
  if (flag) return getResolvedFlag<boolean>({ flags: useFeatureFlagsStore.getState().flags }, flag) === true
  return true
}

/** Build the pin input for a live tiling window. */
export function pinInputFromWindow(
  w: { type: string; props?: Record<string, any> },
  t: TFunction,
): { window: NavbarPinWindow; label: string; icon: string } {
  const props = serializeWindowProps(w.type, w.props ?? {})
  const window = { type: w.type, props }
  return {
    window,
    label: pinLabel({ window }, t),
    icon: pinIcon({ window }),
  }
}

/** Split a list into the two zones, keeping each zone's order. */
export function splitZones<T extends { scope: NavbarPinScope }>(pins: T[]): { workspace: T[]; personal: T[] } {
  return {
    workspace: pins.filter((p) => p.scope === "workspace"),
    personal: pins.filter((p) => p.scope === "personal"),
  }
}

/** Whether a live window is already anchored in either zone of the active workspace. @spec NAV-REQ-16 */
/** The dataTransfer type of a row drag (NAV-REQ-19): never `text/plain`, so the tiling ignores it. */
export const PIN_DRAG_MIME = "application/x-teros-navbar-pin"

/**
 * The order of a zone after dropping `movedId` before `beforeId` (null = at
 * the end). Dropping a row on itself or on its own next slot is a no-op.
 * @spec NAV-REQ-19
 */
export function reorderPinIds(ids: string[], movedId: string, beforeId: string | null): string[] {
  if (!ids.includes(movedId) || beforeId === movedId) return ids.slice()
  const rest = ids.filter((id) => id !== movedId)
  const at = beforeId === null ? rest.length : rest.indexOf(beforeId)
  if (at < 0) return [...rest, movedId]
  return [...rest.slice(0, at), movedId, ...rest.slice(at)]
}

export function findPinForWindow(
  pins: NavbarPinData[],
  w: { type: string; props?: Record<string, any> },
): NavbarPinData | undefined {
  const key = windowKey(w.type, serializeWindowProps(w.type, w.props ?? {}))
  return pins.find((p) => p.key === key)
}
