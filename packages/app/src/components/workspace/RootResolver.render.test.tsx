/**
 * Root resolver failure screen (regression tests).
 *
 * Bug: when the session URL could not be resolved (listWorkspaces failed —
 * backend down, 401, network — or the user has no workspaces), the resolver
 * rendered null — a dead blank page with no spinner, no message, no action.
 * The user could not tell a broken app from a loading one.
 *
 * Fix, exercised here through the production chain (effect → listWorkspaces →
 * failure state → Retry → effect re-runs):
 *   1. A failure renders the editorial error screen (EditorialScreen — the
 *      same card as the pretty 404), NOT a blank page: title + description
 *      + a Retry button.
 *   2. The two failures get distinct copy: 'request-failed' (may recover on
 *      retry) vs 'no-workspaces' (will not).
 *   3. Retry re-runs the resolution: if the backend recovered, the resolver
 *      proceeds (router.replace to the workspace URL + setActiveWorkspace);
 *      if it fails again, the screen comes back up.
 *
 * The route component lives in app/(workspace)/index.tsx (outside src/), but
 * vitest's include pattern governs test FILES, not imports — the test imports
 * the production component directly.
 *
 *   cd packages/app && npx vitest run src/components/workspace/RootResolver.render.test.tsx
 */
import '../../i18n' // side-effect: initializes i18n (en-US) so t() returns real strings
import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TamaguiProvider } from 'tamagui'
import config from '../../../tamagui.config'
import { useAuthStore } from '../../store/authStore'
import { useWorkspaceStore } from '../../store/workspaceStore'

// ── Mocks ────────────────────────────────────────────────────────────────────
// vi.mock factories run before the test body; mock state lives in vi.hoisted
// so the factory and the tests share one object (same pattern as
// WorkspaceShellInit.render.test.tsx).

const h = vi.hoisted(() => ({
  /** listWorkspaces result: throw an Error (request-failed) or resolve. */
  listWorkspaces: vi.fn(),
  /** expo-router useRouter.replace spy. */
  replace: vi.fn(),
}))

vi.mock('expo-router', () => ({
  useRouter: () => ({ replace: h.replace }),
}))

vi.mock('../../services/terosClientSingleton', () => ({
  getTerosClient: () => ({ workspace: { listWorkspaces: h.listWorkspaces } }),
}))

// The resolver reads authStore.isHydrated and workspaceStore.activeWorkspaceId /
// setActiveWorkspace. Both stores are real (zustand vanilla state), reset
// between tests; storage calls inside setActiveWorkspace are async fire-and-
// forget — the assertions never await them.

import WorkspaceIndex from '../../../app/(workspace)/index'

// ── Harness ──────────────────────────────────────────────────────────────────
// The resolver's state updates land in microtasks (the listWorkspaces await),
// so every render/click is followed by a macrotask flush INSIDE the same
// async act — otherwise the setFailure update fires outside any act scope
// (act warning) and the assertions race the effect.

/** Render the resolver and drive its async effect to completion. */
async function renderResolver() {
  let utils!: ReturnType<typeof render>
  await act(async () => {
    utils = render(
      <TamaguiProvider config={config} defaultTheme="dark">
        <WorkspaceIndex />
      </TamaguiProvider>,
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return utils
}

/** Click a button and drive the re-run effect to completion, in one act. */
async function clickAndFlush(button: HTMLElement) {
  await act(async () => {
    fireEvent.click(button)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  h.listWorkspaces.mockReset()
  h.replace.mockReset()
  useAuthStore.setState({ isHydrated: true })
  useWorkspaceStore.setState({ activeWorkspaceId: null })
})

afterEach(() => {
  // Wrap in act: this hook runs BEFORE testing-library's auto-cleanup, so the
  // resolver may still be mounted — a bare setState would re-render it
  // outside any act scope (act warning).
  act(() => {
    useAuthStore.setState({ isHydrated: false })
    useWorkspaceStore.setState({ activeWorkspaceId: null })
  })
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Root resolver — failure is a screen, not silence', () => {
  it('renders the editorial error screen (not a blank page) when listWorkspaces fails', async () => {
    h.listWorkspaces.mockRejectedValue(new Error('backend down'))
    const { getByText, queryByText } = await renderResolver()

    // The failure screen, not null: title + description + Retry.
    expect(getByText("We couldn't load your workspace")).toBeTruthy()
    expect(getByText(/couldn't reach the server/)).toBeTruthy()
    const retry = getByText('Retry')
    expect(retry).toBeTruthy()

    // The no-workspaces copy is NOT shown (distinct failure copy).
    expect(queryByText('No workspace to load')).toBeNull()

    // And no navigation happened.
    expect(h.replace).not.toHaveBeenCalled()
  })

  it("renders the no-workspaces copy when the account has no workspaces", async () => {
    h.listWorkspaces.mockResolvedValue({ workspaces: [] })
    const { getByText, queryByText } = await renderResolver()

    expect(getByText('No workspace to load')).toBeTruthy()
    expect(getByText(/account has no workspaces yet/)).toBeTruthy()
    // The request-failed copy is NOT shown.
    expect(queryByText("We couldn't load your workspace")).toBeNull()
    expect(h.replace).not.toHaveBeenCalled()
  })

  it('retry re-runs the resolution: recovery navigates to the workspace URL', async () => {
    // First attempt fails (backend down); retry succeeds.
    h.listWorkspaces
      .mockRejectedValueOnce(new Error('backend down'))
      .mockResolvedValueOnce({
        workspaces: [{ workspaceId: 'ws_private', type: 'private' }],
      })
    const { getByText } = await renderResolver()

    // Failure screen is up.
    expect(getByText("We couldn't load your workspace")).toBeTruthy()

    // Retry: the effect re-runs, the request now succeeds.
    await clickAndFlush(getByText('Retry'))

    // Resolution proceeded: the private workspace became active and the
    // resolver replaced to its session URL.
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws_private')
    expect(h.replace).toHaveBeenCalledWith('/workspace/ws_private')
  })

  it('retry with the backend still down returns to the failure screen', async () => {
    h.listWorkspaces.mockRejectedValue(new Error('backend down'))
    const { getByText, queryByText } = await renderResolver()

    expect(getByText("We couldn't load your workspace")).toBeTruthy()

    // Retry: fails again → the screen comes back up.
    await clickAndFlush(getByText('Retry'))

    expect(getByText("We couldn't load your workspace")).toBeTruthy()
    expect(queryByText('Retry')).toBeTruthy()
    expect(h.replace).not.toHaveBeenCalled()
  })
})
