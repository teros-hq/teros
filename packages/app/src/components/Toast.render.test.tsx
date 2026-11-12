import { act, cleanup } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderWithTamagui } from "../test/renderWithTamagui"
import { TerosToastProvider, useToast } from "./Toast"

let handle: ReturnType<typeof useToast> | null = null

function Handle() {
  handle = useToast()
  return null
}

function focusAnEmbeddedFrame(): void {
  const frame = document.createElement("iframe")
  document.body.appendChild(frame)
  frame.focus()
  window.dispatchEvent(new FocusEvent("blur"))
}

describe("TerosToastProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    document.body.innerHTML = ""
  })

  it("closes a toast after its duration", async () => {
    const view = renderWithTamagui(
      <TerosToastProvider>
        <Handle />
      </TerosToastProvider>,
    )
    await act(async () => {
      handle?.show("Saved", { type: "success", duration: 1000 })
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(view.queryByText("Saved")).not.toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(view.queryByText("Saved")).toBeNull()
  })

  it("still waits while the person is in another window", async () => {
    const view = renderWithTamagui(
      <TerosToastProvider>
        <Handle />
      </TerosToastProvider>,
    )
    await act(async () => {
      handle?.show("Saved", { type: "success", duration: 1000 })
      await vi.advanceTimersByTimeAsync(50)
    })
    await act(async () => {
      window.dispatchEvent(new FocusEvent("blur"))
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(view.queryByText("Saved")).not.toBeNull()
    await act(async () => {
      window.dispatchEvent(new FocusEvent("focus"))
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(view.queryByText("Saved")).toBeNull()
  })

  it("keeps counting down while the terminal iframe has the focus", async () => {
    const view = renderWithTamagui(
      <TerosToastProvider>
        <Handle />
      </TerosToastProvider>,
    )
    await act(async () => {
      handle?.show("Bash installed", { type: "success", duration: 1000 })
      await vi.advanceTimersByTimeAsync(50)
    })
    await act(async () => {
      focusAnEmbeddedFrame()
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(view.queryByText("Bash installed")).not.toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(view.queryByText("Bash installed")).toBeNull()
    await act(async () => {
      handle?.show("Shell 1 finished", { type: "success", duration: 1000 })
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(view.queryByText("Shell 1 finished")).not.toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(view.queryByText("Shell 1 finished")).toBeNull()
  })
})
