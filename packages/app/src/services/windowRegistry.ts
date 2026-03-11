/**
 * Window Registry - Window type registration system
 *
 * Allows registering different window types (chat, browser, editor, etc.)
 * in an agnostic way. Each type defines its component, icon, color and behaviour.
 */

import type { ComponentType } from 'react';

// ============================================
// TYPES
// ============================================

export interface WindowSize {
  width: number;
  height: number;
}

export interface WindowTypeDefinition<TProps = Record<string, any>> {
  // === IDENTITY (required) ===
  type: string; // Unique ID: 'chat', 'apps', etc.

  // === DISPLAY (required) ===
  displayName: string; // "Chat", "Apps"
  icon: ComponentType<{ size?: number; color?: string }>;
  color: string; // Icon color in tabs, e.g. '#4A9BA8'
  getColor?: (props: TProps) => string | undefined; // Dynamic color based on props
  getTitle: (props: TProps) => string;
  getSubtitle?: (props: TProps) => string | undefined;

  // === BEHAVIOUR ===
  singleton?: boolean; // Only one instance allowed (e.g. Profile)
  getKey?: (props: TProps) => string | undefined; // For deduplication (e.g. chat uses channelId)
  allowMultiple?: boolean; // Allow multiple instances without a key (default: true)
  isLauncher?: boolean; // Can be opened from the launcher without prior context

  // === LAYOUT ===
  defaultSize: WindowSize;
  minSize?: WindowSize;
  maxSize?: WindowSize;

  // === COMPONENTE ===
  component: ComponentType<TProps & { windowId: string }>;

  // === SERIALIZATION (for persistence) ===
  serialize: (props: TProps) => Record<string, any>;
  deserialize: (data: Record<string, any>) => TProps;

  // === LIFECYCLE HOOKS (optional) ===
  onOpen?: (windowId: string, props: TProps) => void;
  onClose?: (windowId: string, props: TProps) => boolean | void; // return false to cancel
  onFocus?: (windowId: string, props: TProps) => void;
  onBlur?: (windowId: string, props: TProps) => void;
}

// ============================================
// REGISTRY CLASS
// ============================================

class WindowRegistry {
  private types = new Map<string, WindowTypeDefinition<any>>();

  /**
   * Register a new window type
   */
  register<TProps>(definition: WindowTypeDefinition<TProps>): void {
    if (this.types.has(definition.type)) {
      console.warn(`[WindowRegistry] Overwriting existing window type: ${definition.type}`);
    }
    this.types.set(definition.type, definition);
  }

  /**
   * Unregister a window type
   */
  unregister(type: string): void {
    this.types.delete(type);
  }

  /**
   * Get the definition for a type
   */
  get<TProps = Record<string, any>>(type: string): WindowTypeDefinition<TProps> | undefined {
    return this.types.get(type) as WindowTypeDefinition<TProps> | undefined;
  }

  /**
   * Check if a type is registered
   */
  has(type: string): boolean {
    return this.types.has(type);
  }

  /**
   * Get all registered types
   */
  getAll(): WindowTypeDefinition<any>[] {
    return Array.from(this.types.values());
  }

  /**
   * Get types that are launchers (can be opened without context)
   */
  getLauncherTypes(): WindowTypeDefinition<any>[] {
    return this.getAll().filter((def) => def.isLauncher);
  }
}

// Singleton instance
export const windowRegistry = new WindowRegistry();
