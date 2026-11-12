/**
 * Workspace-switch default-window race (regression tests).
 *
 * Bug: the group layout's isReady gate latched true on the FIRST layout restore
 * (layoutRestored boolean, never re-armed), so on a workspace switch
 * WorkspaceShellInit's effect 2 judged the layout while the NEW workspace's
 * restore was still in flight — the OLD workspace's layout was still in the
 * tilingStore:
 *   - A(with layout) → B(empty): effect 2 saw A's truthy layout → no default
 *     window → B's restore landed empty → BLANK SCREEN.
 *   - A(empty) → B(empty): the default window opened for A was wiped by B's
 *     in-flight restore → BLANK SCREEN (effect 2 never re-ran: its deps never
 *     changed after the latch).
 *
 * Fix (three pieces, exercised here through the production chain —
 * setActiveWorkspace → restoreFromStorage → gate → effect 2):
 *   1. tilingStore: every restoreFromStorage completion stamps a monotonic
 *      restoreGeneration + layoutRestoredForWorkspace (the workspace active at
 *      completion — the same source the PersistedDriver buckets state by).
 *   2. useLayoutRestoreGate (the group layout's isReady): derived from the
 *      generation, re-arms on every restore instead of latching on the first.
 *   3. WorkspaceShellInit effect 2: also gated on
 *      layoutRestoredForWorkspace === workspaceId — this workspace's own
 *      restore must have landed before the layout is judged.
 *
 * UPDATE (Pablo, 30-oct — dynamic desktops): effect 2 (the default
 * conversations window) was REMOVED entirely — an empty desktop must STAY
 * empty. It fired on every switch to an empty desktop because the
 * /desktop/[n] route remounts and resets the once-per-workspace latch,
 * making empty desktops unusable. First-run UX is EmptyLayout's actions.
 * Pieces 1-2 (the generation/gate machinery) remain in production — the
 * group layout still uses the gate to avoid racing restoreFromStorage — and
 * the tests below now assert the new invariant: NO automatic window ever
 * opens, on first load or on any workspace switch.
 *
 * The storage mock defers the WORKSPACE_LAYOUT read, so each test controls
 * exactly when a restore lands (the in-flight window where the race lived).
 * Nothing here touches real persistence.
 *
 * NOTE on driving restoreFromStorage directly: in production,
 * workspaceStore.setActiveWorkspace chains persistedDriver.load(wsId) →
 * restoreFromStorage() via a Metro lazy-`require` of tilingStore (circular-dep
 * workaround). That `require` cannot resolve under vitest's ESM transform, so
 * the internal chain degrades gracefully (its .catch logs) and the tests call
 * restoreFromStorage() themselves — the exact entry point the production chain
 * calls, with the same active-workspace bucketing.
 */
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type WindowTypeDefinition, windowRegistry } from '../../services/windowRegistry';
import { useTilingStore, type SerializedWorkspaceState } from '../../store/tilingStore';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { WorkspaceShellInit } from './WorkspaceShellInit';
import { useLayoutRestoreGate } from './useLayoutRestoreGate';

// ── Storage mock ─────────────────────────────────────────────────────────────
// In-memory, per-workspace buckets — the same shape the PersistedDriver gives
// restoreFromStorage. The WORKSPACE_LAYOUT read is deferrable so a test can
// hold a restore in flight (where the race lived) and land it on demand.
//
// Mock state lives in vi.hoisted: vi.mock factories run before the test body,
// so plain top-level variables would still be in their TDZ at factory time.

const h = vi.hoisted(() => {
  const KEYS = {
    WORKSPACE_LAYOUT: 'teros_workspace_layout',
    ACTIVE_DESKTOP_INDEX: 'teros_active_desktop_index',
    LAST_ACTIVE_DESKTOP_INDEX: 'teros_last_active_desktop_index',
    ACTIVE_WORKSPACE: 'teros_active_workspace_id',
    LAST_ACTIVE_WORKSPACE: 'teros_last_active_workspace_id',
  } as const;
  /** workspaceId → serialized layout (absent bucket = never saved) */
  const buckets = new Map<string, string>();
  const misc = new Map<string, string>();
  const state = {
    /** Workspace the driver buckets by — wired to the real workspaceStore in
     *  beforeEach, exactly like the app's configurePersistedDriver. */
    getWorkspaceId: (): string | null => null,
    /** When 'deferred', the next WORKSPACE_LAYOUT read parks until resolved. */
    readMode: 'immediate' as 'immediate' | 'deferred',
    pendingRead: null as { resolve: () => void } | null,
  };
  return { KEYS, buckets, misc, state };
});

vi.mock('../../services/storage', () => ({
  STORAGE_KEYS: h.KEYS,
  storage: {
    get: async (key: string): Promise<unknown> => {
      if (key === h.KEYS.WORKSPACE_LAYOUT) {
        // Bucket value is captured at READ time, like the real driver.
        const wsId = h.state.getWorkspaceId();
        const raw = wsId ? h.buckets.get(wsId) ?? null : null;
        const value = raw === null ? null : JSON.parse(raw);
        if (h.state.readMode === 'deferred') {
          return new Promise((resolve) => {
            h.state.pendingRead = { resolve: () => resolve(value) };
          });
        }
        return value;
      }
      const raw = h.misc.get(key);
      return raw === undefined ? null : JSON.parse(raw);
    },
    set: async (key: string, value: unknown) => {
      h.misc.set(key, JSON.stringify(value));
    },
    remove: async (key: string) => {
      h.misc.delete(key);
    },
  },
  persistedDriver: { load: async () => {} },
  getCurrentWorkspaceId: () => h.state.getWorkspaceId(),
}));

// ── Fake window types ────────────────────────────────────────────────────────
// 'conversations' must be registered or openWindow throws; the seeded layouts
// use a separate 'seed' type so "a default conversations window opened" is
// unambiguous. Restore validates window types against the registry.

const fakeDef = (type: string): WindowTypeDefinition => ({
  type,
  audience: 'user',
  displayName: type,
  icon: (() => null) as unknown as WindowTypeDefinition['icon'],
  color: '#000000',
  getTitle: () => type,
  defaultSize: { width: 100, height: 100 },
  component: (() => null) as unknown as WindowTypeDefinition['component'],
  serialize: () => ({}),
  deserialize: (() => ({})) as WindowTypeDefinition['deserialize'],
});

const CONVERSATIONS = 'conversations';
const SEED = '__shell_init_seed__';
const WS_A = 'ws_a';
const WS_B = 'ws_b';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Serialized state with one SEED window on desktop 0. */
function serializedWithSeedWindow(): SerializedWorkspaceState {
  return {
    version: 2,
    desktops: [
      {
        id: 'desktop_0',
        layout: { type: 'container', id: 'c_seed', windowIds: ['w_seed'], activeWindowId: 'w_seed' },
        activeContainerId: 'c_seed',
      },
      { id: 'desktop_1', layout: null, activeContainerId: null },
      { id: 'desktop_2', layout: null, activeContainerId: null },
    ],
    windows: {
      w_seed: {
        id: 'w_seed',
        type: SEED,
        props: {},
        containerId: 'c_seed',
        desktopIndex: 0,
        hasNotification: false,
        history: [{ type: SEED, props: {} }],
        historyIndex: 0,
      },
    },
    activeDesktopIndex: 0,
    maxDesktops: 3,
    nextId: 2,
  };
}

/** Flush microtasks + one macrotask so async chains and the gate's drop/rise
 *  render cycles all settle inside act(). */
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** Fire the layout restore for the ACTIVE workspace (see module docstring:
 *  the production entry point, driven directly because workspaceStore's
 *  Metro lazy-require of tilingStore cannot resolve under vitest). */
async function startRestore() {
  await act(async () => {
    useTilingStore.getState().restoreFromStorage().catch(() => {});
    // Advance the restore chain to the deferred WORKSPACE_LAYOUT read: it
    // parks after 1-2 immediate reads (desktop index), each one microtask
    // hop ahead. Without these hops pendingRead is still null when
    // landPendingRestore() runs.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Start + settle a restore in immediate mode. startRestore MUST be awaited:
 *  it runs its own act(), and starting flush()'s act() before it resolves
 *  overlaps the two scopes — React warns "overlapping act() calls" and leaves
 *  its act queue inconsistent, so later tests' effects stop flushing (the
 *  file-order-dependent failures of (b)/(c)/(d)/gate). */
async function runRestore() {
  await startRestore();
  await flush();
}

/** Land the in-flight deferred restore. */
async function landPendingRestore() {
  expect(h.state.pendingRead).toBeTruthy();
  await act(async () => {
    h.state.pendingRead!.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
  h.state.pendingRead = null;
}

function hasConversationsWindow() {
  return Object.values(useTilingStore.getState().windows).some((w) => w.type === CONVERSATIONS);
}
function hasSeedWindow() {
  return Object.values(useTilingStore.getState().windows).some((w) => w.type === SEED);
}

/** Resets both singletons + mock state. resetState() alone is not enough: it
 *  never touches layoutRestored / restoreGeneration / layoutRestoredForWorkspace. */
function resetStores() {
  useTilingStore.setState({
    desktops: [0, 1, 2].map((i) => ({ id: `desktop_${i}`, layout: null, activeContainerId: null })),
    windows: {},
    activeDesktopIndex: 0,
    maxDesktops: 3,
    nextId: 1,
    layoutRestored: false,
    restoreGeneration: 0,
    layoutRestoredForWorkspace: null,
  });
  useWorkspaceStore.setState({ activeWorkspaceId: null, windows: {}, activeFloatingWindowId: null });
}

/** The production chain: the group layout's gate driving the shell component. */
function Harness({ workspaceId }: { workspaceId: string }) {
  const isReady = useLayoutRestoreGate();
  return <WorkspaceShellInit workspaceId={workspaceId} isReady={isReady} />;
}

/** Switch workspaces the URL-driven way (prop leads, the store follows via
 *  effect 1 — the switch a /workspace/[id] link performs; the navbar's
 *  store-first switch converges to the same state once DesktopUrlSync
 *  rewrites the URL). Set readMode='deferred' beforehand to hold the new
 *  workspace's restore in flight, then startRestore() separately. */
async function switchWorkspace(rerenderHarness: (id: string) => void, workspaceId: string) {
  await act(async () => {
    rerenderHarness(workspaceId);
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  windowRegistry.register(fakeDef(CONVERSATIONS));
  windowRegistry.register(fakeDef(SEED));
  h.buckets.clear();
  h.misc.clear();
  h.state.pendingRead = null;
  h.state.readMode = 'immediate';
  resetStores();
  // Production wiring: the driver buckets by the ACTIVE workspace.
  h.state.getWorkspaceId = () => useWorkspaceStore.getState().activeWorkspaceId;
});

afterEach(() => {
  windowRegistry.unregister(CONVERSATIONS);
  windowRegistry.unregister(SEED);
});

describe('workspace-switch default-window race', () => {
  // NOTE (Pablo, 30-oct — dynamic desktops): the default conversations window
  // was REMOVED. An empty desktop/workspace must STAY empty (EmptyLayout).
  // These tests now assert the invariant: no automatic window ever opens,
  // on first load or on any workspace/desktop switch.
  it("(a) A with layout → B empty: B stays empty — no default window opens", async () => {
    h.buckets.set(WS_A, JSON.stringify(serializedWithSeedWindow()));
    // B: no bucket — empty workspace.

    const { rerender } = render(<Harness workspaceId={WS_A} />);
    const rerenderHarness = (id: string) => rerender(<Harness workspaceId={id} />);

    // First load on A: effect 1 switches the store, A's restore lands.
    await flush();
    await runRestore();
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(WS_A);
    expect(hasSeedWindow()).toBe(true);
    expect(hasConversationsWindow()).toBe(false); // A has a layout → no default
    expect(useTilingStore.getState().layoutRestoredForWorkspace).toBe(WS_A);
    expect(useTilingStore.getState().restoreGeneration).toBe(1);

    // Switch to B; hold B's restore in flight (the race window).
    h.state.readMode = 'deferred';
    await switchWorkspace(rerenderHarness, WS_B);
    await startRestore();
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(WS_B);
    expect(hasConversationsWindow()).toBe(false);

    // B's restore lands: B stays EMPTY — no default window (the old fallback
    // is gone; the empty state is the EmptyLayout screen).
    await landPendingRestore();
    expect(useTilingStore.getState().layoutRestoredForWorkspace).toBe(WS_B);
    expect(useTilingStore.getState().restoreGeneration).toBe(2);
    expect(hasConversationsWindow()).toBe(false); // ← stays empty
    expect(hasSeedWindow()).toBe(false); // A's layout replaced by B's empty restore
  });

  it("(b) A empty → B with layout: B's layout lands intact, no default window wipes it", async () => {
    // A: no bucket — empty. B: saved layout.
    h.buckets.set(WS_B, JSON.stringify(serializedWithSeedWindow()));

    const { rerender } = render(<Harness workspaceId={WS_A} />);
    const rerenderHarness = (id: string) => rerender(<Harness workspaceId={id} />);

    // First load on A: empty → stays empty (no default window anymore).
    await flush();
    await runRestore();
    expect(hasConversationsWindow()).toBe(false);
    expect(useTilingStore.getState().layoutRestoredForWorkspace).toBe(WS_A);

    // Switch to B; hold B's restore in flight.
    h.state.readMode = 'deferred';
    await switchWorkspace(rerenderHarness, WS_B);
    await startRestore();
    expect(hasConversationsWindow()).toBe(false);

    // B's restore lands: B's saved layout replaces A's session intact.
    await landPendingRestore();
    expect(useTilingStore.getState().layoutRestoredForWorkspace).toBe(WS_B);
    expect(hasSeedWindow()).toBe(true);
    expect(hasConversationsWindow()).toBe(false);
  });

  it('(d) A empty → B empty: both stay empty — no blank-screen fallback window', async () => {
    // Neither workspace has a saved layout.
    const { rerender } = render(<Harness workspaceId={WS_A} />);
    const rerenderHarness = (id: string) => rerender(<Harness workspaceId={id} />);

    // First load on A: empty → stays empty.
    await flush();
    await runRestore();
    expect(hasConversationsWindow()).toBe(false);

    // Switch to B: B's empty restore wipes A's session; B stays empty too.
    h.state.readMode = 'deferred';
    await switchWorkspace(rerenderHarness, WS_B);
    await startRestore();
    await landPendingRestore();
    expect(useTilingStore.getState().layoutRestoredForWorkspace).toBe(WS_B);
    expect(hasConversationsWindow()).toBe(false);
  });

  it('(c) first load unchanged: empty workspace stays empty, saved layout restores intact', async () => {
    // Empty workspace: no default window — the empty state is the screen.
    const first = render(<Harness workspaceId={WS_A} />);
    await flush();
    await runRestore();
    expect(useTilingStore.getState().layoutRestoredForWorkspace).toBe(WS_A);
    expect(hasConversationsWindow()).toBe(false);
    first.unmount();
    resetStores();

    // Saved layout: restores intact, nothing added on top.
    h.buckets.set(WS_A, JSON.stringify(serializedWithSeedWindow()));
    const second = render(<Harness workspaceId={WS_A} />);
    await flush();
    await runRestore();
    expect(hasSeedWindow()).toBe(true);
    expect(hasConversationsWindow()).toBe(false);
    second.unmount();
  });

  it('gate re-arms per restore: isReady drops while a newer restore is unobserved', async () => {
    h.buckets.set(WS_A, JSON.stringify(serializedWithSeedWindow()));
    const gateLog: boolean[] = [];
    function ProbeHarness({ workspaceId }: { workspaceId: string }) {
      const isReady = useLayoutRestoreGate();
      gateLog.push(isReady);
      return <WorkspaceShellInit workspaceId={workspaceId} isReady={isReady} />;
    }

    const { rerender } = render(<ProbeHarness workspaceId={WS_A} />);
    await flush();
    await runRestore();
    expect(gateLog[0]).toBe(false); // before any restore
    expect(gateLog[gateLog.length - 1]).toBe(true); // after A's restore

    h.state.readMode = 'deferred';
    await switchWorkspace((id) => rerender(<ProbeHarness workspaceId={id} />), WS_B);
    await startRestore();
    await landPendingRestore();
    // The gate dropped when B's restore completed (re-arm) and rose again
    // once observed — never latching on A's restore.
    expect(gateLog[gateLog.length - 1]).toBe(true);
    const firstRise = gateLog.indexOf(true);
    const lastDrop = gateLog.lastIndexOf(false);
    const lastRise = gateLog.lastIndexOf(true);
    expect(lastDrop).toBeGreaterThan(firstRise); // a drop AFTER the first rise
    expect(lastRise).toBeGreaterThan(lastDrop);
  });
});
