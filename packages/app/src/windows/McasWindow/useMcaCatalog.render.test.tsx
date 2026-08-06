/**
 * useMcaCatalog — connection-lifecycle coverage (PR #347 MAJOR).
 *
 * The dashboard render suite (and McasWindow's) hardcode `isConnected: () => true`, so the
 * "client not yet connected → subscribe to `connected`, then load" branch (useMcaCatalog.ts) was
 * never exercised — exactly the reload/resume/reconnect blind spot from TER-369. These tests drive
 * `isConnected: () => false` and assert:
 *   - no load happens until the `connected` event fires (loading stays true; listAllMcas uncalled),
 *   - firing `connected` runs exactly one load and the one-shot listener detaches itself (`off`),
 *   - unmounting BEFORE `connected` detaches the listener too (no leak) and never loads.
 *
 * A hook test (renderHook) rather than a full dashboard render: the branch lives entirely in the
 * hook, and driving it in isolation keeps the connection contract unambiguous.
 *
 *   cd packages/app && npx vitest run src/windows/McasWindow/useMcaCatalog.render.test.tsx
 */
import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const listAllMcas = vi.hoisted(() => vi.fn())
const getMcaHealth = vi.hoisted(() => vi.fn())
const isConnected = vi.hoisted(() => vi.fn())
const on = vi.hoisted(() => vi.fn())
const off = vi.hoisted(() => vi.fn())
const clientMock = vi.hoisted(() => ({
  isConnected: (...args: unknown[]) => isConnected(...args),
  on: (...args: unknown[]) => on(...args),
  off: (...args: unknown[]) => off(...args),
  app: {
    listAllMcas: (...args: unknown[]) => listAllMcas(...args),
    getMcaHealth: (...args: unknown[]) => getMcaHealth(...args),
  },
}))
vi.mock("../../services/terosClientSingleton", () => ({
  getTerosClient: () => clientMock,
}))
// The hook only reads `t` for a fallback error string; a trivial identity avoids i18n init in a
// bare hook test.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

import { useMcaCatalog } from "./useMcaCatalog"

const oneMca = { mcas: [{ mcaId: "slack", name: "Slack", tools: ["a"] }] }

function connectedHandler(): () => void {
  const call = on.mock.calls.find((c) => c[0] === "connected")
  if (!call) throw new Error("no 'connected' listener was registered")
  return call[1] as () => void
}

beforeEach(() => {
  listAllMcas.mockReset()
  getMcaHealth.mockReset()
  isConnected.mockReset()
  on.mockReset()
  off.mockReset()
  listAllMcas.mockResolvedValue(oneMca)
  getMcaHealth.mockResolvedValue({ health: [] })
})

describe("useMcaCatalog connection lifecycle (PR #347 MAJOR)", () => {
  it("defers the load until the `connected` event, then loads once and detaches the listener", async () => {
    isConnected.mockReturnValue(false)

    const { result } = renderHook(() => useMcaCatalog())

    // Not connected: no load yet, still loading, and a one-shot `connected` listener is registered.
    expect(listAllMcas).not.toHaveBeenCalled()
    expect(result.current.loading).toBe(true)
    expect(on).toHaveBeenCalledWith("connected", expect.any(Function))

    // Fire `connected` → the deferred load runs.
    const handler = connectedHandler()
    await act(async () => {
      handler()
    })

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(listAllMcas).toHaveBeenCalledTimes(1)
    expect(result.current.mcas).toHaveLength(1)
    // The one-shot listener detaches itself after firing (no accumulation across reconnects).
    expect(off).toHaveBeenCalledWith("connected", handler)
  })

  it("detaches the `connected` listener on unmount before connect (no leak) and never loads", async () => {
    isConnected.mockReturnValue(false)

    const { unmount } = renderHook(() => useMcaCatalog())
    const handler = connectedHandler()

    unmount()

    // Cleanup detaches the exact listener it registered; the load never ran.
    expect(off).toHaveBeenCalledWith("connected", handler)
    expect(listAllMcas).not.toHaveBeenCalled()
  })
})
