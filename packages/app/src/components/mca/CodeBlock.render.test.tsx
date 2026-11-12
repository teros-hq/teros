import React from "react"
import { describe, expect, it } from "vitest"
import { renderWithTamagui } from "../../test/renderWithTamagui"
import { CodeBlock } from "./CodeBlock"

describe("CodeBlock", () => {
  it("[LOADP-AC-3] renders the code with a registered and with an unregistered language", () => {
    const json = renderWithTamagui(<CodeBlock code={'{"a": 1}'} language="json" />)
    expect(json.container.textContent).toContain('{"a": 1}')
    // Registered language: Prism wraps tokens in styled spans.
    expect(json.container.querySelectorAll("span").length).toBeGreaterThan(1)

    const cobol = renderWithTamagui(<CodeBlock code="MOVE 1 TO X." language="cobol" />)
    expect(cobol.container.textContent).toContain("MOVE 1 TO X.")
  })
})
