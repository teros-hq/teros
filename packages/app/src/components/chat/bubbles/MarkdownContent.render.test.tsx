import { marked } from "marked"
import { describe, expect, it } from "vitest"
import { renderHtmlSpy } from "../../../test/reactNativeRenderHtmlStub"
import { renderWithTamagui } from "../../../test/renderWithTamagui"
import { TamaguiProvider } from "tamagui"
import tamaguiConfig from "../../../../tamagui.config"
import { MarkdownContent, PreRenderer } from "./MarkdownContent"

/**
 * TER-461 — MarkdownContent:
 *  - PreRenderer.extractText: recorre recursivamente el árbol de nodos para sacar el
 *    texto plano del <pre> (lógica propia, no de la lib).
 *  - El componente parsea el markdown con `marked` y pasa el HTML resultante a
 *    RenderHtml. RenderHtml está stubbeado (lib Flow-typed) y captura su `source`,
 *    así verificamos el cableado marked→HTML sin renderizar HTML real.
 */
describe("PreRenderer — extractText", () => {
  it("concatena el texto de un árbol de nodos anidado", () => {
    const tnode = {
      domNode: {
        children: [
          { type: "text", data: "const " },
          { children: [{ type: "text", data: "x = 1" }] },
        ],
      },
    }
    const { container } = renderWithTamagui(<PreRenderer tnode={tnode} />)
    expect(container.querySelector("code")?.textContent).toBe("const x = 1")
  })

  it("devuelve cadena vacía para un nodo sin texto ni hijos", () => {
    const { container } = renderWithTamagui(<PreRenderer tnode={{ domNode: { type: "tag" } }} />)
    expect(container.querySelector("code")?.textContent).toBe("")
  })
})

describe("MarkdownContent — cableado marked → RenderHtml", () => {
  it("parsea el markdown a HTML y se lo pasa a RenderHtml", () => {
    renderWithTamagui(<MarkdownContent text="**hola**" />)
    expect(renderHtmlSpy.source?.html).toBe(marked.parse("**hola**"))
    expect(renderHtmlSpy.source?.html).toContain("<strong>") // HTML real, no markdown crudo
  })
})

describe("MarkdownContent — type-in reveal over rendered text", () => {
  it("cuts the rendered document at reveal.end and tags the in-flight run", () => {
    // "parse ahead, reveal behind": the FULL source is parsed; the HTML is
    // cut at `end` rendered chars and the runs crossing the boundary carry
    // data-from (absolute start) + data-settled-until (the boundary).
    renderWithTamagui(<MarkdownContent text="hola mundo cruel" reveal={{ end: 10, boundary: 5 }} />)
    const html = renderHtmlSpy.source?.html ?? ""
    expect(html).toContain('<span data-tail data-from="0" data-settled-until="5">hola mundo</span>')
    expect(html).not.toContain("cruel")
  })

  it("keeps the final structure under the reveal: bold is bold from its first char", () => {
    // 'hola **negrita** y mundo' → rendered 'hola negrita y mundo'. Revealing
    // 8 chars shows 'hola ' plain and 'neg' INSIDE <strong> — no literal
    // asterisks, no later pop.
    renderWithTamagui(
      <MarkdownContent text="hola **negrita** y mundo" reveal={{ end: 8, boundary: 5 }} />,
    )
    const html = renderHtmlSpy.source?.html ?? ""
    expect(html).toContain(
      '<strong><span data-tail data-from="5" data-settled-until="5">neg</span></strong>',
    )
    expect(html).not.toContain("*")
    expect(html).not.toContain("y mundo")
  })

  it("a heading is a heading before its text is fully revealed; empty blocks never appear", () => {
    renderWithTamagui(
      <MarkdownContent text={"# Titulo\n\nparrafo"} reveal={{ end: 3, boundary: 0 }} />,
    )
    const html = renderHtmlSpy.source?.html ?? ""
    expect(html).toMatch(
      /<h1[^>]*><span data-tail data-from="0" data-settled-until="0">Tit<\/span><\/h1>/,
    )
    expect(html).not.toContain("<p>")
  })

  it("renders plain again without reveal (stream ended)", () => {
    const { rerender } = renderWithTamagui(
      <MarkdownContent text="a b" reveal={{ end: 2, boundary: 1 }} />,
    )
    expect(renderHtmlSpy.source?.html).toContain("data-tail")
    rerender(
      <TamaguiProvider config={tamaguiConfig} defaultTheme="dark">
        <MarkdownContent text="a b" />
      </TamaguiProvider>,
    )
    expect(renderHtmlSpy.source?.html).not.toContain("data-tail")
    expect(renderHtmlSpy.source?.html).toBe(marked.parse("a b"))
  })
})

describe("MarkdownContent — strikethrough disabled (MD-STRIKE-1)", () => {
  // @fixme nira - 2026-10-19 : Pablo doesn't use ~~del~~ — the tilde must
  // render literal in agent output (~50ms, aprox~, paths, etc.)
  it("renders ~~text~~ as literal tildes, not <del>", () => {
    renderWithTamagui(<MarkdownContent text="~~tachado~~" />)
    const html = renderHtmlSpy.source?.html ?? ""
    expect(html).not.toContain("<del>")
    expect(html).not.toContain("</del>")
    expect(html).toContain("~~tachado~~")
  })

  it("renders ~text~ as literal tildes, not <del>", () => {
    renderWithTamagui(<MarkdownContent text="~50ms" />)
    const html = renderHtmlSpy.source?.html ?? ""
    expect(html).not.toContain("<del>")
    expect(html).toContain("~50ms")
  })

  it("keeps other markdown rules intact: bold, italic, code, links", () => {
    renderWithTamagui(<MarkdownContent text="**bold** *italic* `code` [link](https://x.com)" />)
    const html = renderHtmlSpy.source?.html ?? ""
    expect(html).toContain("<strong>bold</strong>")
    expect(html).toContain("<em>italic</em>")
    expect(html).toContain("<code>code</code>")
    // The shared policy opens links in a new tab, noopener (MD-UNIFY).
    expect(html).toContain('<a href="https://x.com" target="_blank" rel="noopener noreferrer">link</a>')
  })
})
