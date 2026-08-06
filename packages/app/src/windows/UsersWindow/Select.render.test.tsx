/**
 * Select — the accessible listbox extracted from the users filter bar (PR4).
 * Assertions that BITE:
 *   - it is NOT a raw HTML `<select>` (the whole point of the extraction),
 *   - opening the trigger reveals the options and choosing one drives `onChange`
 *     so a controlled parent's value actually updates.
 *
 *   cd packages/app && npx vitest run src/windows/UsersWindow/Select.render.test.tsx
 */
import { fireEvent } from "@testing-library/react"
import { useState } from "react"
import { describe, expect, it } from "vitest"
import { renderWithTamagui } from "../../test/renderWithTamagui"
import { Select } from "./Select"

const OPTS = [
  { key: "a", label: "Alpha" },
  { key: "b", label: "Beta" },
]

function Harness() {
  const [value, setValue] = useState("a")
  return <Select testID="sel" value={value} options={OPTS} onChange={setValue} />
}

describe("Select", () => {
  it("renders an accessible listbox, not a raw <select>", () => {
    const { container, getByTestId } = renderWithTamagui(
      <Select testID="sel" value="a" options={OPTS} onChange={() => {}} />,
    )
    expect(container.querySelector("select")).toBeNull()
    expect(getByTestId("sel").getAttribute("aria-haspopup")).toBe("listbox")
  })

  it("opening it and choosing an option updates the value", () => {
    const { getByTestId, findByTestId } = renderWithTamagui(<Harness />)
    // Starts on Alpha.
    expect(getByTestId("sel").textContent).toContain("Alpha")

    fireEvent.click(getByTestId("sel")) // open
    return findByTestId("sel-opt-b").then((optB) => {
      fireEvent.click(optB) // choose Beta
      expect(getByTestId("sel").textContent).toContain("Beta")
    })
  })
})
