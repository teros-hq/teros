/**
 * Navbar Store - Caches agents and apps data for the sidebar
 *
 * Prevents flicker when navigating between pages by keeping
 * the navbar data in a global store instead of component state.
 */

import { create } from 'zustand';
import { STORAGE_KEYS, storage } from '../services/storage';

export interface NavbarAgent {
  agentId: string;
  name: string;
  role?: string;
  avatarUrl?: string;
  coreId?: string;
  workspaceId?: string;
}

export interface NavbarApp {
  appId: string;
  name: string;
  mcaId: string;
  mcaName: string;
  description: string;
  icon?: string;
  color?: string;
  category: string;
  status: string;
}

export interface NavbarWorkspace {
  workspaceId: string;
  name: string;
  role: 'owner' | 'admin' | 'write' | 'read';
  volumeId: string;
  appearance?: {
    color?: string;
    icon?: string;
  };
  /** Workspace type — 'private' is the user's personal workspace and cannot be deleted/archived */
  type?: 'private' | 'shared';
}

interface NavbarState {
  // State
  agents: NavbarAgent[];
  apps: NavbarApp[];
  workspaces: NavbarWorkspace[];
  isLoading: boolean;
  isLoaded: boolean;
  lastFetchedAt: number | null;

  // UI State
  isExpanded: boolean;
  isMobileMenuOpen: boolean;

  // Actions
  setAgents: (agents: NavbarAgent[]) => void;
  addAgent: (agent: NavbarAgent) => void;
  updateAgent: (agentId: string, patch: Partial<NavbarAgent>) => void;
  removeAgent: (agentId: string) => void;
  setApps: (apps: NavbarApp[]) => void;
  addApp: (app: NavbarApp) => void;
  updateApp: (appId: string, patch: Partial<NavbarApp>) => void;
  removeApp: (appId: string) => void;
  setWorkspaces: (workspaces: NavbarWorkspace[]) => void;
  addWorkspace: (workspace: NavbarWorkspace) => void;
  updateWorkspace: (workspaceId: string, patch: Partial<NavbarWorkspace>) => void;
  removeWorkspace: (workspaceId: string) => void;
  setLoading: (loading: boolean) => void;
  setLoaded: (loaded: boolean) => void;
  setExpanded: (expanded: boolean) => void;
  setMobileMenuOpen: (open: boolean) => void;
  loadExpandedState: () => Promise<void>;
  reset: () => void;
}

export const useNavbarStore = create<NavbarState>((set) => ({
  // Initial state
  agents: [],
  apps: [],
  workspaces: [],
  isLoading: false,
  isLoaded: false,
  lastFetchedAt: null,

  // UI State
  isExpanded: true,
  isMobileMenuOpen: false,

  // Actions
  setAgents: (agents) => set({ agents }),

  // Idempotent upsert by agentId — guards against double-insert when a session
  // both performs an optimistic local update AND receives the WS event with the
  // same id. If the agent already exists, return the state unchanged.
  addAgent: (agent) =>
    set((state) =>
      state.agents.some((a) => a.agentId === agent.agentId)
        ? state
        : { agents: [...state.agents, agent] },
    ),

  updateAgent: (agentId, patch) =>
    set((state) => ({
      agents: state.agents.map((a) => (a.agentId === agentId ? { ...a, ...patch } : a)),
    })),

  removeAgent: (agentId) =>
    set((state) => ({
      agents: state.agents.filter((a) => a.agentId !== agentId),
    })),

  setApps: (apps) => set({ apps }),

  addApp: (app) =>
    set((state) =>
      state.apps.some((a) => a.appId === app.appId)
        ? state
        : { apps: [...state.apps, app] },
    ),

  updateApp: (appId, patch) =>
    set((state) => ({
      apps: state.apps.map((a) => (a.appId === appId ? { ...a, ...patch } : a)),
    })),

  removeApp: (appId) =>
    set((state) => ({
      apps: state.apps.filter((a) => a.appId !== appId),
    })),

  setWorkspaces: (workspaces) => set({ workspaces }),

  addWorkspace: (workspace) =>
    set((state) =>
      state.workspaces.some((w) => w.workspaceId === workspace.workspaceId)
        ? state
        : { workspaces: [...state.workspaces, workspace] },
    ),

  updateWorkspace: (workspaceId, patch) =>
    set((state) => ({
      workspaces: state.workspaces.map((w) =>
        w.workspaceId === workspaceId ? { ...w, ...patch } : w,
      ),
    })),

  removeWorkspace: (workspaceId) =>
    set((state) => ({
      workspaces: state.workspaces.filter((w) => w.workspaceId !== workspaceId),
    })),

  setLoading: (isLoading) => set({ isLoading }),

  setLoaded: (isLoaded) =>
    set({
      isLoaded,
      lastFetchedAt: isLoaded ? Date.now() : null,
    }),

  setExpanded: (isExpanded) => {
    set({ isExpanded });
    // Persist to storage
    storage.set(STORAGE_KEYS.NAVBAR_EXPANDED, isExpanded).catch(console.error);
  },

  setMobileMenuOpen: (isMobileMenuOpen) => set({ isMobileMenuOpen }),

  loadExpandedState: async () => {
    try {
      const saved = await storage.get<boolean>(STORAGE_KEYS.NAVBAR_EXPANDED);
      if (saved !== null) {
        set({ isExpanded: saved });
      }
    } catch (error) {
      console.error('[NavbarStore] Failed to load expanded state:', error);
    }
  },

  reset: () =>
    set({
      agents: [],
      apps: [],
      workspaces: [],
      isLoading: false,
      isLoaded: false,
      lastFetchedAt: null,
    }),
}));

// ── Session lifecycle registration ──────────────────────────────────────────
// @todo nira - 2026-05-20: migrate to createSessionStore once circular deps resolved

import { storeRegistry } from './session/StoreRegistry'

storeRegistry.register('navbar', {
  resetSession: async () => {
    const state = useNavbarStore.getState()
    state.reset()
    await storage.remove(STORAGE_KEYS.NAVBAR_EXPANDED)
  },
})
