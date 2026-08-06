/**
 * useUrlSync - Hook to sync the URL with the active window
 *
 * When the active window changes, updates the browser URL
 * without causing navigation (using History API).
 *
 * This allows:
 * - Sharing URLs that directly open a specific window
 * - The browser back button to work correctly
 * - The URL to always reflect the current state
 */

import { usePathname } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { useTilingStore } from '../store/tilingStore';

/** Mapping of window type to URL generator */
type UrlGenerator = (props: Record<string, any>) => string | null;

const urlGenerators: Record<string, UrlGenerator> = {
  // Chat windows
  chat: (props) => {
    if (props.channelId) return `/chat/${props.channelId}`;
    if (props.agentId) return `/chat/new/${props.agentId}`;
    return null;
  },
  conversations: () => '/conversations',
  'archived-conversations': () => '/archived',

  // Dev tools
  console: () => '/console',

  // Config windows
  agent: (props) => {
    if (!props.agentId) return null;
    return `/agent/${props.agentId}`;
  },
  app: (props) => {
    if (!props.appId) return null;
    return `/app/${props.appId}`;
  },
  apps: () => '/apps',
  catalog: () => '/catalog',

  // Admin windows
  providers: () => '/providers',
  'agent-cores': () => '/admin/agent-cores',
  mcas: () => '/admin/mcas',
  users: () => '/admin/users',
  'agent-usage': () => '/admin/agent-usage',
  'model-health': () => '/admin/model-health',
  monitoring: () => '/admin/monitoring',
  'feature-flags': () => '/admin/feature-flags',
  'session-trace': (props) =>
    props.sessionUsageId ? `/admin/trace/${props.sessionUsageId}` : null,
  'billing-audit': (props) =>
    props.userId ? `/admin/billing-audit/${props.userId}` : '/admin/billing-audit',
  'billing-requests': () => '/admin/billing-requests',
  'billing-teams': () => '/admin/billing-teams',

  // User
  profile: () => '/profile',
  'pending-approvals': () => '/pending-approvals',
  skills: () => '/skills',
  'create-agent': () => '/create-agent',
  launcher: () => '/launcher',
  // uitest: () => '/uitest',  // disabled — UITestWindow removed from launcher

  // Workspaces
  workspaces: () => '/workspaces',
  workspace: (props) => (props.workspaceId ? `/workspace/${props.workspaceId}` : null),

  // Board
  board: (props) => {
    if (props.projectId) return `/board/${props.projectId}`;
    return null;
  },

  // Project
  project: (props) => (props.projectId ? `/project/${props.projectId}` : null),

  // File windows — filePaths contain slashes, so encode as query param
  'file-browser': (props) => {
    if (!props.workspaceId) return null;
    const params = new URLSearchParams();
    if (props.initialPath) params.set('path', props.initialPath);
    const qs = params.toString();
    return `/files/${props.workspaceId}${qs ? `?${qs}` : ''}`;
  },
  'file-viewer': (props) => {
    if (!props.filePath) return null;
    const params = new URLSearchParams();
    params.set('path', props.filePath);
    if (props.workspaceId) params.set('workspaceId', props.workspaceId);
    if (props.channelId) params.set('channelId', props.channelId);
    return `/file-viewer?${params.toString()}`;
  },
  'code-editor': (props) => {
    if (!props.filePath) return null;
    const params = new URLSearchParams();
    params.set('path', props.filePath);
    if (props.workspaceId) params.set('workspaceId', props.workspaceId);
    if (props.channelId) params.set('channelId', props.channelId);
    return `/code-editor?${params.toString()}`;
  },
  'markdown-viewer': (props) => {
    if (!props.filePath) return null;
    const params = new URLSearchParams();
    params.set('path', props.filePath);
    if (props.workspaceId) params.set('workspaceId', props.workspaceId);
    if (props.channelId) params.set('channelId', props.channelId);
    return `/markdown-viewer?${params.toString()}`;
  },

  // Terminal — encode cwd as query param
  terminal: (props) => {
    const params = new URLSearchParams();
    if (props.initialCwd) params.set('cwd', props.initialCwd);
    if (props.workspaceId) params.set('workspaceId', props.workspaceId);
    const qs = params.toString();
    return `/terminal${qs ? `?${qs}` : ''}`;
  },

  // Browserbase — one URL per session
  'browserbase-live-view': (props) =>
    props.sessionId ? `/browserbase/${props.sessionId}` : null,
};

/**
 * Hook to sync the URL with the active window
 *
 * @param enabled - If false, does not sync (useful during initial load)
 */
export function useUrlSync(enabled: boolean = true): void {
  const pathname = usePathname();

  // Get state from the active desktop
  const desktops = useTilingStore((state) => state.desktops);
  const activeDesktopIndex = useTilingStore((state) => state.activeDesktopIndex);
  const windows = useTilingStore((state) => state.windows);

  const activeDesktop = desktops[activeDesktopIndex];
  const layout = activeDesktop?.layout;
  const activeContainerId = activeDesktop?.activeContainerId;

  const lastUrlRef = useRef<string | null>(null);
  const isInitialMount = useRef(true);

  useEffect(() => {
    // Only works on web
    if (Platform.OS !== 'web' || !enabled) return;

    // Skip first render to avoid interfering with initial navigation
    if (isInitialMount.current) {
      isInitialMount.current = false;
      lastUrlRef.current = pathname;
      return;
    }

    // Find the active window
    if (!layout || !activeContainerId) {
      // If there is no layout or active container, navigate to '/' (home)
      // This happens when the last tab is closed
      if (layout === null && pathname !== '/') {
        try {
          window.history.pushState(null, '', '/');
          console.log('[UrlSync] No active windows, reset URL to: /');
        } catch (e) {
          console.warn('[UrlSync] Failed to reset URL to root:', e);
        }
      }
      return;
    }

    // Find the active container
    const findContainer = (node: any): any => {
      if (!node) return null;
      if (node.type === 'container' && node.id === activeContainerId) return node;
      if (node.type === 'split') {
        return findContainer(node.first) || findContainer(node.second);
      }
      return null;
    };

    const container = findContainer(layout);
    if (!container || !container.activeWindowId) return;

    const activeWindow = windows[container.activeWindowId];
    if (!activeWindow) return;

    // Generar URL para este tipo de ventana
    const generator = urlGenerators[activeWindow.type];
    if (!generator) return;

    const newUrl = generator(activeWindow.props);
    if (!newUrl) return;

    // No actualizar si ya estamos en esa URL
    if (newUrl === pathname || newUrl === lastUrlRef.current) return;

    // Actualizar URL y crear entrada en el historial
    try {
      lastUrlRef.current = newUrl;
      window.history.pushState({ windowId: activeWindow.id, type: activeWindow.type }, '', newUrl);
      console.log('[UrlSync] Updated URL to:', newUrl);
    } catch (e) {
      console.warn('[UrlSync] Failed to update URL:', e);
    }
  }, [enabled, layout, windows, activeContainerId, pathname]);
}

/**
 * Generates the URL for a specific window
 * Useful for creating links programmatically
 */
export function getWindowUrl(type: string, props: Record<string, any>): string | null {
  const generator = urlGenerators[type];
  return generator ? generator(props) : null;
}
