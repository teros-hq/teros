import { act, renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@tamagui/lucide-icons", () => ({ Folder: () => null, Rocket: () => null }))

import { useLucideIcons } from "./lucideIcons"

describe("useLucideIcons", () => {
  it("[LOADP-AC-2] never loads while disabled; loads on demand, then answers synchronously", async () => {
    const off = renderHook(() => useLucideIcons(false))
    await act(async () => {
      await Promise.resolve()
    })
    expect(off.result.current).toBeNull()

    const on = renderHook(() => useLucideIcons(true))
    expect(on.result.current).toBeNull()
    await waitFor(() => expect(on.result.current).not.toBeNull())
    expect(Object.keys(on.result.current!)).toContain("Rocket")

    // Already loaded: a later consumer gets it on its first render.
    const later = renderHook(() => useLucideIcons(true))
    expect(later.result.current).not.toBeNull()
  })
})
