/**
 * useAtMention
 *
 * Manages the full @mention system lifecycle:
 * - Detects `@` trigger in the input text
 * - Fetches workspace resources (agents, projects, apps, skills, conversations, workspaces)
 * - Filters by the query typed after `@`
 * - Returns grouped results for the dropdown
 * - Tracks selected mentions (chips)
 *
 * Resources are fetched once per workspace and cached in module-level Map.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getTerosClient } from '../services/terosClientSingleton';
import { useWorkspaceStore } from '../store/workspaceStore';

// ============================================================================
// Types
// ============================================================================

export type MentionResourceType =
  | 'agent'
  | 'project'
  | 'app'
  | 'skill'
  | 'conversation'
  | 'file'
  | 'workspace';

export interface MentionResource {
  id: string;
  type: MentionResourceType;
  name: string;
  subtitle?: string;
  avatarUrl?: string;
}

export interface MentionGroup {
  type: MentionResourceType;
  label: string;
  items: MentionResource[];
}

export interface MentionChip {
  /** Unique chip instance id (not the resource id) */
  id: string;
  resource: MentionResource;
}

// ============================================================================
// Constants
// ============================================================================

const GROUP_LABELS: Record<MentionResourceType, string> = {
  agent: 'Agentes',
  project: 'Proyectos',
  app: 'Apps',
  skill: 'Skills',
  conversation: 'Conversaciones',
  file: 'Ficheros',
  workspace: 'Workspaces',
};

const GROUP_ORDER: MentionResourceType[] = [
  'agent',
  'project',
  'app',
  'skill',
  'conversation',
  'file',
  'workspace',
];

const TYPE_LABELS: Record<MentionResourceType, string> = {
  agent: 'Agent',
  project: 'Project',
  app: 'App',
  skill: 'Skill',
  conversation: 'Conversation',
  file: 'File',
  workspace: 'Workspace',
};

// Module-level cache: workspaceId → resources[]
const resourceCache = new Map<string, MentionResource[]>();
const fetchingSet = new Set<string>();

// ============================================================================
// Context resolvers (exported for use outside the hook)
// ============================================================================

/**
 * Produces plain-text context for the agent to understand the referenced resources.
 * Format: `Agent: "Alice" [agent_abc123]`
 */
export function resolveMentionChipsToContext(chips: MentionChip[]): string {
  if (chips.length === 0) return '';
  const lines = chips.map(
    ({ resource }) => `${TYPE_LABELS[resource.type]}: "${resource.name}" [${resource.id}]`,
  );
  return `\n\n[Referenced resources]\n${lines.join('\n')}`;
}

/**
 * Produces the Markdown inline links for each chip, to be appended to the
 * user-visible message text.
 * Format: `[Alice](teros://agent/agent_abc123)`
 */
export function resolveMentionChipsToMarkdown(chips: MentionChip[]): string {
  if (chips.length === 0) return '';
  const links = chips.map(
    ({ resource }) => `[${resource.name}](teros://${resource.type}/${resource.id})`,
  );
  return ' ' + links.join(' ');
}

// ============================================================================
// Chip id counter
// ============================================================================

let _chipCounter = 0;
function newChipId(): string {
  return `chip_${Date.now()}_${++_chipCounter}`;
}

// ============================================================================
// Hook
// ============================================================================

// workspaceId is intentionally NOT a parameter — the hook always reads it from
// useWorkspaceStore so that the active workspace is the single source of truth.
interface UseAtMentionOptions {}

export interface UseAtMentionReturn {
  // Dropdown state
  isOpen: boolean;
  query: string;
  groups: MentionGroup[];
  selectedIndex: number;
  isFetchingResources: boolean;

  // Chips
  chips: MentionChip[];

  // Actions
  /** Call this on every text change, passing the new text and current cursor position */
  onInputChange: (text: string, cursorPos?: number) => void;
  /** Call when the user picks a resource from the dropdown */
  onSelectResource: (resource: MentionResource) => void;
  onRemoveChip: (chipId: string) => void;
  /**
   * Handle keyboard navigation inside the dropdown.
   * Returns true if the key was consumed (caller should preventDefault).
   */
  onKeyDown: (key: string) => boolean;
  closeDropdown: () => void;
  clearChips: () => void;
  /** Produces the context string to append to the message text at send time */
  resolveContext: () => string;
}

export function useAtMention(_options: UseAtMentionOptions = {}): UseAtMentionReturn {
  const client = getTerosClient();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  // ── Local state ────────────────────────────────────────────────────────────
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [chips, setChips] = useState<MentionChip[]>([]);
  const [allResources, setAllResources] = useState<MentionResource[]>([]);
  const [isFetchingResources, setIsFetchingResources] = useState(false);

  // Keep isOpen in a ref so the keydown handler (closure) always sees current value
  const isOpenRef = useRef(isOpen);
  useEffect(() => {
    isOpenRef.current = isOpen;
  }, [isOpen]);

  // ── Sync cache → local state when workspaceId changes ─────────────────────
  useEffect(() => {
    if (!workspaceId) {
      setAllResources([]);
      return;
    }
    const cached = resourceCache.get(workspaceId);
    if (cached) {
      setAllResources(cached);
    } else {
      setAllResources([]);
    }
  }, [workspaceId]);

  // ── Fetch resources ────────────────────────────────────────────────────────
  const fetchResources = useCallback(async () => {
    if (!client || !workspaceId) {
      console.warn('[useAtMention] fetchResources aborted — client:', !!client, 'workspaceId:', workspaceId);
      return;
    }
    if (resourceCache.has(workspaceId)) {
      // Already cached – make sure local state is up to date
      console.log('[useAtMention] Using cached resources for workspace:', workspaceId, resourceCache.get(workspaceId)!.length, 'items');
      setAllResources(resourceCache.get(workspaceId)!);
      return;
    }
    if (fetchingSet.has(workspaceId)) {
      console.log('[useAtMention] Fetch already in flight for workspace:', workspaceId);
      return;
    }

    console.log('[useAtMention] Fetching resources for workspace:', workspaceId);
    fetchingSet.add(workspaceId);
    setIsFetchingResources(true);

    const resources: MentionResource[] = [];

    // ── Agents ──────────────────────────────────────────────────────────────
    try {
      const res = await client.agent.listAgents(workspaceId);
      console.log('[useAtMention] agents raw response:', res);
      for (const a of res.agents ?? []) {
        resources.push({
          id: a.agentId,
          type: 'agent',
          name: a.name || a.fullName,
          subtitle: a.role,
          avatarUrl: a.avatarUrl,
        });
      }
      console.log('[useAtMention] agents loaded:', res.agents?.length ?? 0);
    } catch (e) {
      console.warn('[useAtMention] agents fetch failed:', e);
    }

    // ── Projects ─────────────────────────────────────────────────────────────
    try {
      const res = await client.project.list(workspaceId);
      console.log('[useAtMention] projects raw response:', res);
      for (const p of res.projects ?? []) {
        resources.push({
          id: p.projectId,
          type: 'project',
          name: p.name,
          subtitle: p.description,
        });
      }
      console.log('[useAtMention] projects loaded:', res.projects?.length ?? 0);
    } catch (e) {
      console.warn('[useAtMention] projects fetch failed:', e);
    }

    // ── Apps ─────────────────────────────────────────────────────────────────
    try {
      const res = await client.workspace.listWorkspaceApps(workspaceId);
      console.log('[useAtMention] apps raw response:', res);
      for (const a of res.apps ?? []) {
        resources.push({
          id: a.appId,
          type: 'app',
          name: a.name || (a as any).mcaName || a.appId,
          subtitle: a.description || (a as any).mcaId,
        });
      }
      console.log('[useAtMention] apps loaded:', res.apps?.length ?? 0);
    } catch (e) {
      console.warn('[useAtMention] apps fetch failed:', e);
    }

    // ── Skills ───────────────────────────────────────────────────────────────
    // NOTE: skills use the WsTransport directly via client.workspace.transport
    // (not client.transport which is private in TerosClient)
    try {
      const res = await (client.workspace as any).transport.request('skill.list', { workspaceId });
      console.log('[useAtMention] skills raw response:', res);
      for (const s of (res as any)?.skills ?? []) {
        resources.push({
          id: s.skillId,
          type: 'skill',
          name: s.name,
          subtitle: s.description,
        });
      }
      console.log('[useAtMention] skills loaded:', (res as any)?.skills?.length ?? 0);
    } catch (e) {
      console.warn('[useAtMention] skills fetch failed:', e);
    }

    // ── Conversations ─────────────────────────────────────────────────────────
    try {
      const res = await client.channel.list(workspaceId, undefined, 50);
      console.log('[useAtMention] conversations raw response — channels:', res.channels?.length);
      for (const c of res.channels ?? []) {
        resources.push({
          id: c.channelId,
          type: 'conversation',
          name: c.title || `Chat ${c.channelId.slice(0, 8)}`,
          subtitle: (c as any).agentName,
        });
      }
      console.log('[useAtMention] conversations loaded:', res.channels?.length ?? 0);
    } catch (e) {
      console.warn('[useAtMention] conversations fetch failed:', e);
    }

    // ── Workspaces ────────────────────────────────────────────────────────────
    try {
      const res = await client.workspace.listWorkspaces();
      console.log('[useAtMention] workspaces raw response:', res);
      for (const w of res.workspaces ?? []) {
        resources.push({
          id: w.workspaceId,
          type: 'workspace',
          name: w.name,
          subtitle: w.description,
        });
      }
      console.log('[useAtMention] workspaces loaded:', res.workspaces?.length ?? 0);
    } catch (e) {
      console.warn('[useAtMention] workspaces fetch failed:', e);
    }

    console.log('[useAtMention] Total resources fetched:', resources.length, resources.map(r => `${r.type}:${r.name}`));
    resourceCache.set(workspaceId, resources);
    fetchingSet.delete(workspaceId);
    setAllResources(resources);
    setIsFetchingResources(false);
  }, [client, workspaceId]);

  // ── Filtered & grouped results ─────────────────────────────────────────────
  const groups = useMemo((): MentionGroup[] => {
    if (!isOpen) return [];
    const q = query.toLowerCase().trim();
    const result: MentionGroup[] = [];

    for (const type of GROUP_ORDER) {
      const items = allResources.filter(
        (r) =>
          r.type === type &&
          (q === '' ||
            r.name.toLowerCase().includes(q) ||
            (r.subtitle ?? '').toLowerCase().includes(q)),
      );
      if (items.length > 0) {
        result.push({ type, label: GROUP_LABELS[type], items });
      }
    }
    return result;
  }, [isOpen, query, allResources]);

  const flatItems = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  // Reset selection when query or groups change
  useEffect(() => {
    setSelectedIndex(0);
  }, [query, groups]);

  // ── Input change handler ───────────────────────────────────────────────────
  const onInputChange = useCallback(
    (text: string, cursorPos?: number) => {
      const pos = cursorPos ?? text.length;

      // Strip zero-width spaces (inserted as chip separators) before scanning,
      // but keep a corrected position so the slice is still accurate.
      // We work on the raw `text` string and skip \u200B chars in the walk-back.
      let atPos = -1;
      for (let i = pos - 1; i >= 0; i--) {
        const ch = text[i];
        // Zero-width spaces are transparent — skip them
        if (ch === '\u200B') continue;
        if (ch === ' ' || ch === '\n' || ch === '\t') break; // hit whitespace → no trigger
        if (ch === '@') {
          // Valid trigger: @ at start OR preceded by whitespace / zero-width space
          const before = text[i - 1];
          if (
            i === 0 ||
            before === ' ' ||
            before === '\n' ||
            before === '\t' ||
            before === '\u200B'
          ) {
            atPos = i;
          }
          break;
        }
      }

      if (atPos !== -1) {
        const q = text.slice(atPos + 1, pos);
        setQuery(q);
        if (!isOpenRef.current) {
          // Fix: update ref synchronously so re-entrant calls see the new value
          // immediately (before the useEffect that syncs isOpen → isOpenRef fires).
          isOpenRef.current = true;
          setIsOpen(true);
          fetchResources();
        }
      } else {
        if (isOpenRef.current) {
          // Fix: update ref synchronously before the state update is batched.
          isOpenRef.current = false;
          setIsOpen(false);
          setQuery('');
        }
      }
    },
    [fetchResources],
  );

  // ── Select resource ────────────────────────────────────────────────────────
  const onSelectResource = useCallback((resource: MentionResource) => {
    setChips((prev) => {
      if (prev.some((c) => c.resource.id === resource.id && c.resource.type === resource.type)) {
        return prev; // deduplicate
      }
      return [...prev, { id: newChipId(), resource }];
    });
    // Fix: update ref synchronously so the next onInputChange call (which may
    // fire before the useEffect syncs isOpen → isOpenRef) sees isOpen = false
    // and correctly re-opens the dropdown when the user types '@' again.
    isOpenRef.current = false;
    setIsOpen(false);
    setQuery('');
  }, []);

  // ── Remove chip ────────────────────────────────────────────────────────────
  const onRemoveChip = useCallback((chipId: string) => {
    setChips((prev) => prev.filter((c) => c.id !== chipId));
  }, []);

  // ── Keyboard navigation ────────────────────────────────────────────────────
  const onKeyDown = useCallback(
    (key: string): boolean => {
      if (!isOpenRef.current) return false;

      if (key === 'ArrowDown') {
        setSelectedIndex((i) => Math.min(i + 1, Math.max(0, flatItems.length - 1)));
        return true;
      }
      if (key === 'ArrowUp') {
        setSelectedIndex((i) => Math.max(i - 1, 0));
        return true;
      }
      if (key === 'Enter' || key === 'Tab') {
        const item = flatItems[selectedIndex];
        if (item) {
          onSelectResource(item);
          return true;
        }
        // No item selected: don't consume, let Enter send the message
        return false;
      }
      if (key === 'Escape') {
        setIsOpen(false);
        setQuery('');
        return true;
      }
      return false;
    },
    [flatItems, selectedIndex, onSelectResource],
  );

  // ── Helpers ────────────────────────────────────────────────────────────────
  const closeDropdown = useCallback(() => {
    // Fix: update ref synchronously so the next onInputChange call sees the
    // correct value before React batches the state update and the useEffect fires.
    isOpenRef.current = false;
    setIsOpen(false);
    setQuery('');
  }, []);

  const clearChips = useCallback(() => setChips([]), []);

  /**
   * Resolves mention chips into the Markdown inline links to append to the message text at send time.
   * Only produces the visual Markdown links — the plain-text [Referenced resources] block is
   * intentionally NOT included here (Bug 4 fix).
   */
  const resolveContext = useCallback(() => {
    if (chips.length === 0) return '';
    return resolveMentionChipsToMarkdown(chips);
  }, [chips]);

  return {
    isOpen,
    query,
    groups,
    selectedIndex,
    isFetchingResources,
    chips,
    onInputChange,
    onSelectResource,
    onRemoveChip,
    onKeyDown,
    closeDropdown,
    clearChips,
    resolveContext,
  };
}
