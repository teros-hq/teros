import { fireEvent } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { renderWithTamagui } from "../../test/renderWithTamagui"
import { SegmentedTabs } from "./SegmentedTabs"

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "quota", label: "Quota" },
  { key: "cache", label: "Cache", disabled: true },
]

describe("SegmentedTabs", () => {
  it("renders every tab and marks the active one aria-selected", () => {
    const { getByText } = renderWithTamagui(<SegmentedTabs tabs={TABS} active="overview" onChange={() => {}} />)
    for (const t of TABS) expect(getByText(t.label)).toBeTruthy()
    // The active tab's node (or an ancestor) carries aria-selected=true; the others false.
    const active = getByText("Overview").closest('[role="tab"]')
    expect(active?.getAttribute("aria-selected")).toBe("true")
    const inactive = getByText("Quota").closest('[role="tab"]')
    expect(inactive?.getAttribute("aria-selected")).toBe("false")
  })

  it("fires onChange when an inactive, enabled tab is pressed", () => {
    const onChange = vi.fn()
    const { getByText } = renderWithTamagui(<SegmentedTabs tabs={TABS} active="overview" onChange={onChange} />)
    fireEvent.click(getByText("Quota"))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith("quota")
  })

  it("does not fire onChange for the active tab or a disabled tab", () => {
    const onChange = vi.fn()
    const { getByText } = renderWithTamagui(<SegmentedTabs tabs={TABS} active="overview" onChange={onChange} />)
    fireEvent.click(getByText("Overview")) // active → no-op
    fireEvent.click(getByText("Cache")) // disabled → no-op
    expect(onChange).not.toHaveBeenCalled()
    expect(getByText("Cache").closest('[role="tab"]')?.getAttribute("aria-disabled")).toBe("true")
  })
})
