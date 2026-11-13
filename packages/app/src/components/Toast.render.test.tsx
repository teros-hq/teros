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

  it("[FLOAT-AC-17] a toast can carry a second, quieter action next to its main one", async () => {
    const main = vi.fn()
    const second = vi.fn()
    const view = renderWithTamagui(
      <TerosToastProvider>
        <Handle />
      </TerosToastProvider>,
    )
    await act(async () => {
      handle?.show("Shell 1 needs you", {
        type: "warning",
        duration: 5000,
        action: { label: "Float", onPress: main },
        secondary: { label: "Open", onPress: second },
      })
      await vi.advanceTimersByTimeAsync(50)
    })
    const first = view.getByTestId("toast-action")
    const other = view.getByTestId("toast-secondary")
    expect(first.textContent).toBe("Float")
    expect(other.textContent).toBe("Open")
    expect(first.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await act(async () => {
      first.click()
      other.click()
    })
    expect(main).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it("[FLOAT-AC-17] a toast with one action has no second button", async () => {
    const view = renderWithTamagui(
      <TerosToastProvider>
        <Handle />
      </TerosToastProvider>,
    )
    await act(async () => {
      handle?.show("Saved", { action: { label: "Undo", onPress: () => {} }, duration: 5000 })
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(view.queryByTestId("toast-action")).not.toBeNull()
    expect(view.queryByTestId("toast-secondary")).toBeNull()
  })

  it("draws its title and its message in the app's font, not the browser's default", async () => {
    const view = renderWithTamagui(
      <TerosToastProvider>
        <Handle />
      </TerosToastProvider>,
    )
    await act(async () => {
      handle?.error("Could not open a terminal", "Bash took too long to start.")
      await vi.advanceTimersByTimeAsync(50)
    })
    const drawn = (text: string) =>
      view.getAllByText(text).filter((el) => /is_Toast(Title|Description)/.test(el.className))
    const title = drawn("Could not open a terminal")
    const message = drawn("Bash took too long to start.")
    expect(title).toHaveLength(1)
    expect(message).toHaveLength(1)
    for (const el of [...title, ...message]) expect(el.className).toMatch(/(^| )_ff-/)
  })
})
