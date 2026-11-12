/**
 * To Do markdown viewer (docs/specs/todo/markdown.md): tables, the everyday
 * block/inline subset and malformed input. Since MD-UNIFY v2 (step 5) the
 * viewer is a wrapper over the unified renderer, so these assert the rendered
 * DOM (elements) rather than the hand-drawn kit nodes.
 *
 *   cd packages/app && NODE_ENV=test npx vitest run src/windows/TodoWindow/ui/markdown
 */
import { describe, expect, it } from "vitest"
import { renderWithTamagui } from "../../../test/renderWithTamagui"
import { Markdown } from "./Markdown"

describe("To Do markdown viewer", () => {
  it("[TODOMD-AC-1] a pipe table renders a header row, body rows with the right cell count, the bold cell marked and no literal pipe", () => {
    const src = [
      "| Plan | Price | Seats |",
      "|:-----|:-----:|------:|",
      "| Starter | **9 €** | 1 |",
      "| Team | 29 € | 10 |",
      "| Ent |",
    ].join("\n")
    const { container } = renderWithTamagui(<Markdown source={src} />)
    const table = container.querySelector("table")
    expect(table).not.toBeNull()
    const rows = Array.from(table!.querySelectorAll("tr"))
    expect(rows).toHaveLength(4)
    expect(rows[0].querySelectorAll("th")).toHaveLength(3)
    expect(rows[0].querySelectorAll("td")).toHaveLength(0)
    for (const r of rows.slice(1)) expect(r.querySelectorAll("td")).toHaveLength(3)
    expect(rows[3].querySelectorAll("td")[0].textContent).toBe("Ent")
    expect(rows[3].querySelectorAll("td")[1].textContent).toBe("")
    // alignment per the separator (the align attribute; left is the default)
    const head = rows[0].querySelectorAll("th")
    expect(head[0].getAttribute("align") ?? "left").toBe("left")
    expect(head[1].getAttribute("align")).toBe("center")
    expect(head[2].getAttribute("align")).toBe("right")
    // bold cell: marker stripped, <strong> (the tile underlay is the shared CSS)
    expect(rows[1].querySelectorAll("td")[1].querySelector("strong")?.textContent).toBe("9 €")
    expect(container.textContent).not.toContain("|")
    expect(container.textContent).not.toContain("**")
  })

  it("[TODOMD-AC-2] numbered list, task list, code block, quote, rule, link, inline code, italics and ~ (literal, MD-STRIKE-1) render as their elements", () => {
    const src = [
      "1. First step",
      "2) Second step",
      "",
      "- [ ] open task",
      "- [x] done task",
      "",
      "```",
      "const a = 1",
      "  indented **not bold**",
      "```",
      "",
      "> quoted line",
      "",
      "---",
      "",
      "See [the docs](https://example.com/docs) and `npm test`, *soft* and ~~gone~~ ~50ms.",
    ].join("\n")
    const { container, getByRole } = renderWithTamagui(<Markdown source={src} />)
    const text = container.textContent ?? ""
    // numbered list: an <ol> with the item text, no number characters in the text
    expect(container.querySelectorAll("ol li")).toHaveLength(2)
    expect(text).toContain("First step")
    // task list: box glyphs, no literal brackets
    expect(text).toMatch(/☐/)
    expect(text).toMatch(/☑/)
    expect(text).not.toContain("[ ]")
    expect(text).not.toContain("[x]")
    // fenced code: whitespace preserved, no inline parsing, no fences
    expect(text).toContain("const a = 1")
    expect(text).toContain("indented **not bold**")
    expect(text).not.toContain("```")
    // quote: a blockquote, no marker
    expect(container.querySelector("blockquote")?.textContent).toContain("quoted line")
    expect(text).not.toContain(">")
    // rule: an <hr>, not a paragraph of dashes
    expect(container.querySelector("hr")).not.toBeNull()
    expect(text).not.toContain("---")
    // link
    const link = getByRole("link")
    expect(link.textContent).toBe("the docs")
    expect(link.getAttribute("href")).toBe("https://example.com/docs")
    expect(link.getAttribute("target")).toBe("_blank")
    // inline code, italics
    expect(container.querySelector("p code")?.textContent).toBe("npm test")
    expect(container.querySelector("em")?.textContent).toBe("soft")
    // ~ is literal everywhere (MD-STRIKE-1): no <del>, the tildes stay
    expect(container.querySelector("del")).toBeNull()
    expect(text).toContain("~~gone~~")
    expect(text).toContain("~50ms")
  })

  it("[TODOMD-AC-3] malformed input renders without throwing and keeps the text", () => {
    const src = ["|", "```", "unclosed fence", "an **unmatched marker", "| a | b", "_lonely"].join("\n")
    let out: ReturnType<typeof renderWithTamagui> | undefined
    expect(() => {
      out = renderWithTamagui(<Markdown source={src} />)
    }).not.toThrow()
    const text = out!.container.textContent ?? ""
    // An unclosed fence is a code block to the end of the document (CommonMark):
    // everything after it stays literal text.
    expect(text).toContain("|")
    expect(text).toContain("unclosed fence")
    expect(text).toContain("an **unmatched marker")
    expect(text).toContain("| a | b")
    expect(text).toContain("_lonely")
  })
})
