/**
 * Workspace Store
 *
 * Two responsibilities:
 *
 * 1. Active workspace tracking — which workspace is currently "active" for
 *    the user session. Persisted to storage so it survives page reloads.
 *
 * 2. Floating window manager — manages the set of floating (non-tiled)
 *    windows that live on top of the tiling layout. Used by FloatingWindow,
 *    MinimizedBar, and WindowTitleBar components.
 */

import { create } from 'zustand';
import { storage, STORAGE_KEYS, persistedDriver } from '../services/storage';

// ============================================================================
// FloatingWindow type
// ============================================================================

export interface FloatingWindow {
  id: string;
  type: string;
  props: Record<string, any>;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  isMinimized: boolean;
  isMaximized: boolean;
  isDocked: boolean;
  hasNotification: boolean;
}

// ============================================================================
// Open options
// ============================================================================

export type OpenWindowMode = 'floating' | 'docked';

export interface OpenWindowOptions {
  mode?: OpenWindowMode;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

// ============================================================================
// Store state & actions
// ============================================================================

interface WorkspaceStoreState {
  // ── Active workspace ──────────────────────────────────────────────────────
  /** ID of the currently active workspace, or null if none selected */
  activeWorkspaceId: string | null;

  /** Set the active workspace and persist to storage */
  setActiveWorkspace: (workspaceId: string) => void;

  /** Clear the active workspace (e.g. on logout) */
  clearActiveWorkspace: () => void;

  /** Close all floating windows (e.g. on logout) */
  clearFloatingWindows: () => void;

  /** Reset session — clears workspace + floating windows + storage */
  resetSession: () => Promise<void>;

  /** Hydrate from storage (call once on app start) */
  hydrateActiveWorkspace: () => Promise<void>;

  // ── Floating windows ──────────────────────────────────────────────────────
  /** Map of windowId → FloatingWindow */
  windows: Record<string, FloatingWindow>;

  /** ID of the currently focused floating window */
  activeFloatingWindowId: string | null;

  /** Open (or focus existing) floating window */
  openWindow: (
    type: string,
    props: Record<string, any>,
    options?: OpenWindowOptions,
  ) => string;

  /** Find a window by type and optional props predicate */
  findWindow: (
    type: string,
    predicate?: (props: Record<string, any>) => boolean,
  ) => FloatingWindow | undefined;

  /** Bring a window to the front */
  focusWindow: (windowId: string) => void;

  /** Close and remove a window */
  closeWindow: (windowId: string) => void;

  /** Minimize a window */
  minimizeWindow: (windowId: string) => void;

  /** Maximize a window */
  maximizeWindow: (windowId: string) => void;

  /** Restore a minimized or maximized window */
  restoreWindow: (windowId: string) => void;

  /** Dock a window (attach to sidebar) */
  dockWindow: (windowId: string) => void;

  /** Move a window to a new position */
  moveWindow: (windowId: string, x: number, y: number) => void;

  /** Resize a window */
  resizeWindow: (windowId: string, width: number, height: number) => void;
}

// ============================================================================
// Helpers
// ============================================================================

let _nextZIndex = 100;

function nextZIndex(): number {
  return ++_nextZIndex;
}

let _nextWindowId = 0;

function newWindowId(): string {
  return `fw_${Date.now()}_${++_nextWindowId}`;
}

const DEFAULT_WINDOW_WIDTH = 800;
const DEFAULT_WINDOW_HEIGHT = 600;

function defaultPosition() {
  // Cascade windows slightly so they don't stack exactly
  const offset = (_nextWindowId % 8) * 24;
  return { x: 80 + offset, y: 60 + offset };
}

// ============================================================================
// Store
// ============================================================================

export const useWorkspaceStore = create<WorkspaceStoreState>((set, get) => ({
  // ── Active workspace ──────────────────────────────────────────────────────

  activeWorkspaceId: null,

  setActiveWorkspace: (workspaceId) => {
    set({ activeWorkspaceId: workspaceId });
    // tab-state (sessionStorage): per-tab active workspace
    storage
      .set(STORAGE_KEYS.ACTIVE_WORKSPACE, workspaceId)
      .catch((err) => console.error('[WorkspaceStore] Failed to persist activeWorkspaceId:', err));
    // ui-state (localStorage): fallback for new tabs / device-level last known
    storage
      .set(STORAGE_KEYS.LAST_ACTIVE_WORKSPACE, workspaceId)
      .catch((err) => console.error('[WorkspaceStore] Failed to persist lastActiveWorkspaceId:', err));
    // Load persisted layout for this workspace then restore into tilingStore
    persistedDriver.load(workspaceId).then(() => {
      // Lazy import to avoid circular dependency workspaceStore ↔ tilingStore
      const { useTilingStore } = require('./tilingStore') as typeof import('./tilingStore');
      useTilingStore.getState().restoreFromStorage().catch(console.error);
    }).catch((err: unknown) => console.error('[WorkspaceStore] Failed to load persisted state:', err));
  },

  clearActiveWorkspace: () => {
    set({ activeWorkspaceId: null });
    storage
      .remove(STORAGE_KEYS.ACTIVE_WORKSPACE)
      .catch((err) => console.error('[WorkspaceStore] Failed to clear activeWorkspaceId:', err));
    storage
      .remove(STORAGE_KEYS.LAST_ACTIVE_WORKSPACE)
      .catch((err) => console.error('[WorkspaceStore] Failed to clear lastActiveWorkspaceId:', err));
  },

  clearFloatingWindows: () => {
    set({ windows: {}, activeFloatingWindowId: null });
  },

  hydrateActiveWorkspace: async () => {
    try {
      // 1. Try per-tab sessionStorage first (allows multi-screen workflows)
      let stored = await storage.get<string>(STORAGE_KEYS.ACTIVE_WORKSPACE);
      let source = 'tab-state';

      // 2. Fall back to device-level localStorage for new tabs
      if (!stored) {
        stored = await storage.get<string>(STORAGE_KEYS.LAST_ACTIVE_WORKSPACE);
        source = 'ui-state';
      }

      if (stored) {
        set({ activeWorkspaceId: stored });
        console.log(`[WorkspaceStore] Hydrated activeWorkspaceId from ${source}:`, stored);
        // Load persisted layout for this workspace then restore into tilingStore
        persistedDriver.load(stored).then(() => {
          // Lazy import to avoid circular dependency workspaceStore ↔ tilingStore
          const { useTilingStore } = require('./tilingStore') as typeof import('./tilingStore');
          useTilingStore.getState().restoreFromStorage().catch(console.error);
        }).catch((err: unknown) => console.error('[WorkspaceStore] Failed to load persisted state on hydrate:', err));
      }
    } catch (err) {
      console.error('[WorkspaceStore] Failed to hydrate activeWorkspaceId:', err);
    }
  },

  // ── Floating windows ──────────────────────────────────────────────────────

  windows: {},
  activeFloatingWindowId: null,

  openWindow: (type, props, options = {}) => {
    const { windows } = get();

    // Check if a window of this type with matching props already exists
    const existing = Object.values(windows).find(
      (w) => w.type === type && JSON.stringify(w.props) === JSON.stringify(props),
    );

    if (existing) {
      // Bring existing window to front
      get().focusWindow(existing.id);
      return existing.id;
    }

    const id = newWindowId();
    const pos = defaultPosition();
    const zIndex = nextZIndex();

    const newWindow: FloatingWindow = {
      id,
      type,
      props,
      x: options.x ?? pos.x,
      y: options.y ?? pos.y,
      width: options.width ?? DEFAULT_WINDOW_WIDTH,
      height: options.height ?? DEFAULT_WINDOW_HEIGHT,
      zIndex,
      isMinimized: false,
      isMaximized: false,
      isDocked: options.mode === 'docked',
      hasNotification: false,
    };

    set((state) => ({
      windows: { ...state.windows, [id]: newWindow },
      activeFloatingWindowId: id,
    }));

    return id;
  },

  findWindow: (type, predicate) => {
    const { windows } = get();
    return Object.values(windows).find(
      (w) => w.type === type && (predicate ? predicate(w.props) : true),
    );
  },

  focusWindow: (windowId) => {
    const { windows } = get();
    const win = windows[windowId];
    if (!win) return;

    const zIndex = nextZIndex();

    set((state) => ({
      windows: {
        ...state.windows,
        [windowId]: { ...win, zIndex, isMinimized: false },
      },
      activeFloatingWindowId: windowId,
    }));
  },

  closeWindow: (windowId) => {
    set((state) => {
      const { [windowId]: _removed, ...rest } = state.windows;
      const remaining = Object.keys(rest);
      const activeId =
        state.activeFloatingWindowId === windowId
          ? (remaining[remaining.length - 1] ?? null)
          : state.activeFloatingWindowId;

      return { windows: rest, activeFloatingWindowId: activeId };
    });
  },

  minimizeWindow: (windowId) => {
    set((state) => {
      const win = state.windows[windowId];
      if (!win) return state;
      return {
        windows: { ...state.windows, [windowId]: { ...win, isMinimized: true } },
        activeFloatingWindowId:
          state.activeFloatingWindowId === windowId ? null : state.activeFloatingWindowId,
      };
    });
  },

  maximizeWindow: (windowId) => {
    set((state) => {
      const win = state.windows[windowId];
      if (!win) return state;
      const zIndex = nextZIndex();
      return {
        windows: {
          ...state.windows,
          [windowId]: { ...win, isMaximized: true, isMinimized: false, zIndex },
        },
        activeFloatingWindowId: windowId,
      };
    });
  },

  restoreWindow: (windowId) => {
    set((state) => {
      const win = state.windows[windowId];
      if (!win) return state;
      const zIndex = nextZIndex();
      return {
        windows: {
          ...state.windows,
          [windowId]: { ...win, isMinimized: false, isMaximized: false, zIndex },
        },
        activeFloatingWindowId: windowId,
      };
    });
  },

  dockWindow: (windowId) => {
    set((state) => {
      const win = state.windows[windowId];
      if (!win) return state;
      return {
        windows: { ...state.windows, [windowId]: { ...win, isDocked: true } },
      };
    });
  },

  moveWindow: (windowId, x, y) => {
    set((state) => {
      const win = state.windows[windowId];
      if (!win) return state;
      return { windows: { ...state.windows, [windowId]: { ...win, x, y } } };
    });
  },

  resizeWindow: (windowId, width, height) => {
    set((state) => {
      const win = state.windows[windowId];
      if (!win) return state;
      return { windows: { ...state.windows, [windowId]: { ...win, width, height } } };
    });
  },

  resetSession: async () => {
    const state = useWorkspaceStore.getState();
    await state.clearActiveWorkspace();
    state.clearFloatingWindows();
  },
}));

// ── Session lifecycle registration ──────────────────────────────────────────
// @todo nira - 2026-05-20: migrate to createSessionStore once circular deps resolved

import { storeRegistry } from './session/StoreRegistry'

storeRegistry.register('workspace', {
  resetSession: async () => {
    const state = useWorkspaceStore.getState()
    await state.clearActiveWorkspace()
    state.clearFloatingWindows()
  },
})
