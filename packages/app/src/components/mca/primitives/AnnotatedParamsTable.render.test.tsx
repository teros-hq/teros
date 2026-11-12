/**
 * Render tests — AnnotatedParamsTable.
 *
 * Pins the behaviour the spec's success criteria depend on: no value is hidden
 * behind an unexpandable placeholder, schema descriptions annotate their row, and
 * undeclared params are visibly flagged.
 */

import { fireEvent, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { renderWithTamagui } from "../../../test/renderWithTamagui"
import { AnnotatedParamsTable, ParamRow } from "./AnnotatedParamsTable"
import { PARAM_CAPS } from "./param-relevance"
import i18n from "../../../i18n"

const tr = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts) as string

const SCHEMA = {
  type: "object" as const,
  properties: {
    fileId: { type: "string", description: "Target file." },
    role: { type: "string", enum: ["reader", "writer"], description: "Access level." },
    permissions: { type: "object", description: "Extra flags." },
  },
  required: ["fileId", "role"],
}

describe("AnnotatedParamsTable", () => {
  it("(1) renders each param key and value", () => {
    renderWithTamagui(
      <AnnotatedParamsTable input={{ fileId: "f1", role: "writer" }} schema={SCHEMA} />,
    )
    expect(screen.getByText("fileId")).toBeTruthy()
    expect(screen.getByText("f1")).toBeTruthy()
    expect(screen.getByText("role")).toBeTruthy()
    expect(screen.getByText("writer")).toBeTruthy()
  })

  it("(2) renders the schema description beneath its row", () => {
    renderWithTamagui(<AnnotatedParamsTable input={{ role: "writer" }} schema={SCHEMA} />)
    expect(screen.getByText("Access level.")).toBeTruthy()
  })

  it("(3) flags a param that is not in the schema", () => {
    renderWithTamagui(<AnnotatedParamsTable input={{ mystery: 1 }} schema={SCHEMA} />)
    expect(screen.getByText("not in schema")).toBeTruthy()
  })

  it("(4) summarises a container and expands it on press", () => {
    renderWithTamagui(
      <AnnotatedParamsTable input={{ permissions: { expiry: "2026-09-01" } }} schema={SCHEMA} />,
    )
    expect(screen.getByText("{1 fields}")).toBeTruthy()
    expect(screen.queryByText("2026-09-01")).toBeNull()

    fireEvent.click(screen.getByText("{1 fields}"))

    expect(screen.getByText("expiry")).toBeTruthy()
    expect(screen.getByText("2026-09-01")).toBeTruthy()
  })

  it("(5) renders without a schema — every row still shows its value", () => {
    renderWithTamagui(<AnnotatedParamsTable input={{ anything: "here" }} />)
    expect(screen.getByText("anything")).toBeTruthy()
    expect(screen.getByText("here")).toBeTruthy()
    // No schema was consulted, so nothing can be "not in schema" — that tag
    // means "checked and absent", not "unknown". See param-relevance.ts's
    // collectUndeclaredRows.
    expect(screen.queryByText("not in schema")).toBeNull()
  })

  it("(6) shows the empty hint when the tool takes no parameters", () => {
    renderWithTamagui(<AnnotatedParamsTable input={{}} schema={SCHEMA} />)
    expect(screen.getByText("This tool will be called with no parameters.")).toBeTruthy()
  })

  it("(7) respects maxRows and reveals the rest on toggle", () => {
    const input = { fileId: "f1", role: "writer", a: 1, b: 2, c: 3 }
    renderWithTamagui(<AnnotatedParamsTable input={input} schema={SCHEMA} maxRows={2} />)

    expect(screen.queryByText("c")).toBeNull()
    // a, b and c are absent from SCHEMA, so the toggle names what it is hiding
    // rather than reporting an undifferentiated count — see test (12).
    expect(screen.getByTestId("permission-params-toggle-label").textContent).toBe(
      "Show all 5 parameters — 3 not in schema",
    )
    fireEvent.click(screen.getByTestId("permission-params-toggle"))
    expect(screen.getByText("c")).toBeTruthy()
  })

  it("(8) flags items hidden past the container item cap", () => {
    const manyKeys = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${i}`, i]))
    renderWithTamagui(<AnnotatedParamsTable input={{ permissions: manyKeys }} schema={SCHEMA} />)

    expect(screen.getByText("{15 fields}")).toBeTruthy()
    fireEvent.click(screen.getByText("{15 fields}"))

    expect(screen.getByText("+5 more not shown")).toBeTruthy()
  })

  it("(9) a synthetic child row never shows the not-in-schema tag, even if flagged", () => {
    // A child's declared status is unknowable (the schema covers only top-level
    // properties). This renders the one combination the normal render path cannot
    // produce — synthetic AND undeclared:true — so the `synthetic` guard is actually
    // exercised rather than shadowed by the hardcoded undeclared:false at the
    // construction site in ParamRowChildren.
    renderWithTamagui(
      <ParamRow
        synthetic
        param={{ key: "nested", value: 1, required: false, undeclared: true, container: false }}
      />,
    )
    expect(screen.queryByText("not in schema")).toBeNull()
  })

  it("(10) states what a depth-capped container withheld instead of dead-ending", () => {
    // A container at the nesting cap has no children to reveal, so "show more"
    // would be an inert label. But silence is worse: the row reads as if the
    // container were empty, and on an approval surface a nested credential would
    // be invisible with no signal that anything was hidden. It gets a statement.
    const input = {
      obj: {
        lvl1: {
          child2: 1,
          lvl2: {
            childA: 1,
            childB: 1,
            lvl3: { p: 1, q: 1, r: 1, s: 1 },
          },
        },
      },
    }
    renderWithTamagui(<AnnotatedParamsTable input={input} />)

    fireEvent.click(screen.getByText("{1 fields}"))
    fireEvent.click(screen.getByText("{2 fields}"))
    fireEvent.click(screen.getByText("{3 fields}"))

    expect(screen.getByText("{4 fields}")).toBeTruthy()
    expect(screen.queryByText(/show more/)).toBeNull()
    expect(screen.getByTestId("param-nesting-limit").textContent).toBe(
      "4 nested fields — too deep to show",
    )
  })

  it("(11) expanded children render inside the disclosure that revealed them", () => {
    // The toggle lives in the value column, so the content it discloses must be
    // in that column too. Emitted as a sibling of the row's XStack, children
    // aligned under the 72px key label instead — visually outside the dropdown
    // that owns them, and in the grouped panel sprawling under deny/allow.
    renderWithTamagui(<AnnotatedParamsTable input={{ outer: { inner: "v" } }} />)

    fireEvent.click(screen.getByText("{1 fields}"))

    const region = screen.getByTestId("param-children")
    expect(region).toBeTruthy()
    expect(region.textContent).toContain("inner")
    expect(region.textContent).toContain("v")
  })

  it("(12) the collapsed toggle says when it is hiding an undeclared param", () => {
    // Tier 2 sorts last, so on a call with >=maxRows declared params the
    // undeclared one — the single highest-signal row on an approval surface — is
    // exactly what the cap hides first. The cap stays (an approval card that
    // grows without bound is its own problem), but it must not describe the
    // hidden rows as an undifferentiated count.
    const schema = {
      type: "object" as const,
      properties: {
        fileId: { type: "string" },
        role: { type: "string" },
        sendEmail: { type: "boolean" },
        permissions: { type: "object" },
      },
      required: ["fileId"],
    }
    renderWithTamagui(
      <AnnotatedParamsTable
        input={{ fileId: "f1", role: "writer", sendEmail: true, permissions: {}, mystery: "?" }}
        schema={schema}
        maxRows={4}
      />,
    )

    expect(screen.queryByText("mystery")).toBeNull()
    expect(screen.getByTestId("permission-params-toggle-label").textContent).toBe(
      "Show all 5 parameters — 1 not in schema",
    )

    fireEvent.click(screen.getByTestId("permission-params-toggle"))
    expect(screen.getByText("mystery")).toBeTruthy()
    expect(screen.getByText("not in schema")).toBeTruthy()
  })

  it('(13) "show more" on a clipped value actually reveals the rest', () => {
    // The hint was plain text over a value whose tail had been discarded at
    // bounding time — tapping it did nothing. Approving a filesystem write meant
    // seeing 240 of 1000 characters with no way to read what would be written.
    const long = `${"x".repeat(PARAM_CAPS.maxChars)}TAIL-MARKER`
    renderWithTamagui(<AnnotatedParamsTable input={{ content: long }} />)

    const cell = screen.getByTestId("param-value-more")
    expect(cell.textContent).toContain(tr("mca.permissionDetail.showMore"))
    expect(cell.textContent).not.toContain("TAIL-MARKER")

    fireEvent.click(cell)
    expect(screen.getByTestId("param-value-more").textContent).toContain("TAIL-MARKER")

    fireEvent.click(screen.getByTestId("param-value-more"))
    expect(screen.getByTestId("param-value-more").textContent).not.toContain("TAIL-MARKER")
  })

  it("(14) a depth-capped container gets the nesting statement, not a value toggle", () => {
    // Both are `truncated`, but only a scalar has a rest to show. Offering a
    // toggle here would be the same inert affordance in a new place.
    renderWithTamagui(<AnnotatedParamsTable input={{ deep: { a: { b: { c: { d: 1 } } } } }} />)

    expect(screen.queryByTestId("param-value-more")).toBeNull()
  })
})
