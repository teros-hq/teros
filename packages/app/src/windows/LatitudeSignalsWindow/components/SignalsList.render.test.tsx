/**
 * Render tests for the F4·C2 signals dashboard rows (SignalsList / SignalCard).
 *
 * Mutation-verified. The strong assertions: the deep link fires window.open with
 * the signal's URL on press; a signal WITHOUT a deep link is inert (no open); a
 * muted signal is flagged; lifecycle states render as labelled chips (not colour
 * alone).
 */

import { fireEvent } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { LatitudeSignalSummary } from "../../../services/AdminApi"
import { renderWithTamagui } from "../../../test/renderWithTamagui"
import { SignalsList } from "./SignalsList"

const signal = (over: Partial<LatitudeSignalSummary> = {}): LatitudeSignalSummary => ({
  id: "sig_1",
  slug: "tool-errors",
  name: "Tool calls return a generic error",
  description: "Recurring tool_error scores across turns",
  source: "custom",
  states: ["escalating"],
  muted: false,
  occurrences: 12,
  affectedSessionsPercent: 0.25,
  trend: [
    { bucket: "2026-07-08", count: 3 },
    { bucket: "2026-07-09", count: 9 },
  ],
  tags: ["provider:anthropic"],
  firstSeenAt: "2026-07-08T00:00:00Z",
  lastSeenAt: "2026-07-09T10:00:00Z",
  deepLinkUrl: "http://lat.local:3000/projects/p/signals/sig_1",
  ...over,
})

describe("SignalsList (F4·C2)", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("renders a signal's name, description, occurrences and its state chip", () => {
    const { getByText } = renderWithTamagui(<SignalsList signals={[signal()]} />)
    expect(getByText("Tool calls return a generic error")).toBeTruthy()
    expect(getByText("Recurring tool_error scores across turns")).toBeTruthy()
    expect(getByText("12")).toBeTruthy() // occurrences
    expect(getByText("escalating")).toBeTruthy() // state chip, labelled
  })

  it("renders every signal in the list", () => {
    const { getByText } = renderWithTamagui(
      <SignalsList
        signals={[signal({ id: "a", name: "First" }), signal({ id: "b", name: "Second" })]}
      />,
    )
    expect(getByText("First")).toBeTruthy()
    expect(getByText("Second")).toBeTruthy()
  })

  it("calls the injected handler with the deep link on press", () => {
    const onOpenSignal = vi.fn()
    const { getByText } = renderWithTamagui(
      <SignalsList signals={[signal()]} onOpenSignal={onOpenSignal} />,
    )
    fireEvent.click(getByText("Tool calls return a generic error"))
    expect(onOpenSignal).toHaveBeenCalledWith("http://lat.local:3000/projects/p/signals/sig_1")
  })

  it("opens the deep link via window.open by default", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null)
    const { getByText } = renderWithTamagui(<SignalsList signals={[signal()]} />)
    fireEvent.click(getByText("Tool calls return a generic error"))
    expect(open).toHaveBeenCalledWith(
      "http://lat.local:3000/projects/p/signals/sig_1",
      "_blank",
      "noopener,noreferrer",
    )
  })

  it("is inert (no open) when the signal has no deep link", () => {
    const onOpenSignal = vi.fn()
    const { getByText } = renderWithTamagui(
      <SignalsList signals={[signal({ deepLinkUrl: "" })]} onOpenSignal={onOpenSignal} />,
    )
    fireEvent.click(getByText("Tool calls return a generic error"))
    expect(onOpenSignal).not.toHaveBeenCalled()
  })

  it("flags a muted signal", () => {
    const { getByText } = renderWithTamagui(<SignalsList signals={[signal({ muted: true })]} />)
    expect(getByText("Muted")).toBeTruthy()
  })
})
