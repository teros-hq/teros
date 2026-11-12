/**
 * Window Registry - Window type registration system
 *
 * Allows registering different window types (chat, browser, editor, etc.)
 * in an agnostic way. Each type defines its component, icon, color and behaviour.
 */

import type { ComponentType } from "react"

// ============================================
// TYPES
// ============================================

export interface WindowSize {
  width: number
  height: number
}

/**
 * Who a window type is for. REQUIRED on every definition, so a new window
 * cannot ship without someone deciding it (and an unknown audience is shown
 * to nobody — the gate fails closed).
 *   user   everyone
 *   admin  role 'admin' or 'super'
 *   dev    development builds only (or admins with the `devtools.enabled` flag)
 */
export type WindowAudience = "user" | "admin" | "dev"

export interface WindowViewer {
  role?: string | null
  /** Resolved `devtools.enabled` flag. */
  devtools?: boolean
}

export function isAdminRole(role?: string | null): boolean {
  return role === "admin" || role === "super"
}

/** Whether this viewer may see / open a window type. */
export function canSeeWindow(
  def: Pick<WindowTypeDefinition<any>, "audience">,
  viewer: WindowViewer,
): boolean {
  switch (def.audience) {
    case "user":
      return true
    case "admin":
      return isAdminRole(viewer.role)
    case "dev":
      return (typeof __DEV__ !== "undefined" && __DEV__) || (isAdminRole(viewer.role) && !!viewer.devtools)
    default:
      return false
  }
}

/** What a rail widget receives (NAV-REQ-20): the pin's open props and the active workspace. */
export interface WindowWidgetProps<TProps = Record<string, any>> {
  props: TProps
  workspaceId: string | null
  /** The pinned window is open and focused. */
  on: boolean
}

export interface WindowTypeDefinition<TProps = Record<string, any>> {
  // === IDENTITY (required) ===
  type: string // Unique ID: 'chat', 'apps', etc.

  // === DISPLAY (required) ===
  displayName: string // "Chat", "Apps"
  icon: ComponentType<{ size?: number; color?: string }>
  /** Phosphor glyph name (kebab-case) — the tab strip and launcher prefer it over `icon`. */
  phIcon?: string
  color: string // Icon color in tabs, e.g. '#4A9BA8'
  getColor?: (props: TProps) => string | undefined // Dynamic color based on props
  getTitle: (props: TProps) => string
  getSubtitle?: (props: TProps) => string | undefined

  // === BEHAVIOUR ===
  getKey?: (props: TProps) => string | undefined // For deduplication (e.g. chat uses channelId)
  allowMultiple?: boolean // Allow multiple instances without a key (default: true)
  isLauncher?: boolean // Can be opened from the launcher without prior context
  /**
   * Never open this type as a preview tab (docs/specs/ui/preview-tabs.md).
   * For working surfaces and live views whose silent replacement would hide
   * running state (the launcher, a terminal, a live browser view, the code
   * editor). Defaults to false — every type is previewable unless it opts out.
   */
  noPreview?: boolean
  /** Who this window is for — see `WindowAudience`. */
  audience: WindowAudience
  featureFlag?: string // Feature flag key that must be truthy for this window to be shown/opened
  /**
   * The rail widget of a pinned window: a compact live summary rendered inside
   * the pin's card. Absent → the pin is rows-only. @spec NAV-REQ-20
   */
  widget?: ComponentType<WindowWidgetProps<TProps>>
  /**
   * Whether a personal pin of this window may be global, and with which props
   * it then opens in the ACTIVE workspace (workspace-bound ids stripped). Return
   * null when the window is bound to a workspace entity (a conversation, a
   * project, a focused task). Absent → never global. @spec NAV-REQ-21
   */
  portable?: (props: TProps) => Record<string, any> | null

  // === LAYOUT ===
  defaultSize: WindowSize
  minSize?: WindowSize
  maxSize?: WindowSize

  // === COMPONENTE ===
  component: ComponentType<TProps & { windowId: string }>

  // === SERIALIZATION (for persistence) ===
  serialize: (props: TProps) => Record<string, any>
  deserialize: (data: Record<string, any>) => TProps

  // === LIFECYCLE HOOKS (optional) ===
  onOpen?: (windowId: string, props: TProps) => void
  onClose?: (windowId: string, props: TProps) => boolean | void // return false to cancel
  onFocus?: (windowId: string, props: TProps) => void
  onBlur?: (windowId: string, props: TProps) => void

  // === WINDOW CONTROLS ===
  capabilities?: {
    canMinimize?: boolean
    canMaximize?: boolean
    canClose?: boolean
  }
}

// ============================================
// REGISTRY CLASS
// ============================================

class WindowRegistry {
  private types = new Map<string, WindowTypeDefinition<any>>()

  /**
   * Register a new window type
   */
  register<TProps>(definition: WindowTypeDefinition<TProps>): void {
    if (this.types.has(definition.type)) {
      console.warn(`[WindowRegistry] Overwriting existing window type: ${definition.type}`)
    }
    this.types.set(definition.type, definition)
  }

  /**
   * Unregister a window type
   */
  unregister(type: string): void {
    this.types.delete(type)
  }

  /**
   * Get the definition for a type
   */
  get<TProps = Record<string, any>>(type: string): WindowTypeDefinition<TProps> | undefined {
    return this.types.get(type) as WindowTypeDefinition<TProps> | undefined
  }

  /**
   * Check if a type is registered
   */
  has(type: string): boolean {
    return this.types.has(type)
  }

  /**
   * Get all registered types
   */
  getAll(): WindowTypeDefinition<any>[] {
    return Array.from(this.types.values())
  }

  /**
   * Get types that are launchers (can be opened without context)
   */
  /** Who is looking — wired by the app root (role + devtools flag). Until
   *  it is wired the viewer is anonymous: user windows only. */
  private viewer: () => WindowViewer = () => ({})
  setViewer(fn: () => WindowViewer) {
    this.viewer = fn
  }
  /** Whether the current viewer may open this window type. */
  canOpen(def: Pick<WindowTypeDefinition<any>, "audience">): boolean {
    return canSeeWindow(def, this.viewer())
  }

  getLauncherTypes(): WindowTypeDefinition<any>[] {
    return this.getAll().filter((def) => def.isLauncher)
  }
}

// Singleton instance
export const windowRegistry = new WindowRegistry()
