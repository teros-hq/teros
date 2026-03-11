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
  removeAgent: (agentId: string) => void;
  setApps: (apps: NavbarApp[]) => void;
  setWorkspaces: (workspaces: NavbarWorkspace[]) => void;
  addWorkspace: (workspace: NavbarWorkspace) => void;
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

  addAgent: (agent) => set((state) => ({ agents: [...state.agents, agent] })),

  removeAgent: (agentId) =>
    set((state) => ({
      agents: state.agents.filter((a) => a.agentId !== agentId),
    })),

  setApps: (apps) => set({ apps }),

  setWorkspaces: (workspaces) => set({ workspaces }),

  addWorkspace: (workspace) => set((state) => ({ workspaces: [...state.workspaces, workspace] })),

  setLoading: (isLoading) => set({ isLoading }),

  setLoaded: (isLoaded) =>
    set({
      isLoaded,
      lastFetchedAt: isLoaded ? Date.now() : null,
    }),

  setExpanded: (isExpanded) => {
    set({ isExpanded });
    // Persist to storage
    storage.setItem(STORAGE_KEYS.NAVBAR_EXPANDED, JSON.stringify(isExpanded)).catch(console.error);
  },

  setMobileMenuOpen: (isMobileMenuOpen) => set({ isMobileMenuOpen }),

  loadExpandedState: async () => {
    try {
      const saved = await storage.getItem(STORAGE_KEYS.NAVBAR_EXPANDED);
      if (saved !== null) {
        const isExpanded = JSON.parse(saved);
        set({ isExpanded });
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
