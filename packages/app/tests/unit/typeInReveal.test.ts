import { describe, expect, it } from "vitest"
import { renderedText, revealHtml, UNHEARD_ATTR } from "../../src/components/chat/bubbles/typeInReveal"

// Voice PoC 2026-10-31: an interrupted spoken reply keeps its whole prose and
// paints the unheard tail muted (one <span data-unheard> per text run).
describe("revealHtml — unheard mode", () => {
  const html = "<p>Hola <strong>mundo</strong> cruel.</p><p>Segundo párrafo.</p>"

  it("cut mode (default) still truncates at `end`", () => {
    const out = revealHtml(html, null, 7)
    expect(renderedText(out)).toBe("Hola mu")
    expect(out).not.toContain(UNHEARD_ATTR)
  })

  it("keeps the whole document and wraps every run past `end` as unheard", () => {
    const out = revealHtml(html, null, 7, { unheard: true })
    expect(renderedText(out)).toBe(renderedText(html))
    // The run that crosses the cut is split: heard part (a settled tail span
    // when boundary is null — pre-existing, renders plain), rest muted.
    expect(out).toContain(`mu</span><span ${UNHEARD_ATTR}>ndo</span></strong><span ${UNHEARD_ATTR}> cruel.</span></p>`)
    // Runs entirely past the cut are wrapped whole — inside their own tags.
    expect(out).toContain(`<p><span ${UNHEARD_ATTR}>Segundo párrafo.</span></p>`)
    // The heard prefix is untouched.
    expect(out.startsWith("<p>Hola <strong>")).toBe(true)
  })

  it("end = 0 mutes everything, end ≥ length mutes nothing", () => {
    const all = revealHtml(html, null, 0, { unheard: true })
    expect(renderedText(all)).toBe(renderedText(html))
    // Four text runs: "Hola ", "mundo", " cruel.", "Segundo párrafo."
    expect(all.match(new RegExp(UNHEARD_ATTR, "g"))?.length).toBe(4)
    const none = revealHtml(html, null, 999, { unheard: true })
    expect(none).toBe(html)
  })
})
