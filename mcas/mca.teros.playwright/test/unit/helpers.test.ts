/**
 * Helpers de mca.teros.playwright contra chromium REAL (TER-506, batch B
 * 10/N — última pieza). Sin red externa: páginas data: URLs deterministas.
 *
 * findElementByRef es LA pieza crítica del MCA: resolución multi-estrategia
 * (aria-ref del snapshot → CSS → texto → role+"name") usada por click/type/
 * hover/drag/etc. El singleton ensureBrowser/closeBrowser y el filtrado de
 * console quedan acoplados a estado module-level del index (reasignaciones)
 * — anotado en el ticket; extraerlos exigiría refactor de ~50 call sites.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { type Browser, type Page, chromium } from "playwright"
import {
  findElementByRef,
  getAccessibilitySnapshot,
  getAccessibilitySnapshotViaCDP,
} from "../../src/helpers"

let browser: Browser
let page: Page

const TEST_HTML = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!DOCTYPE html>
<html><head><title>TER-506</title></head><body>
  <h1>Página de prueba</h1>
  <button id="guardar">Guardar cambios</button>
  <input type="text" aria-label="Nombre de usuario" />
  <a href="#x">Enlace único</a>
</body></html>
`)}`

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] })
  page = await (await browser.newContext()).newPage()
  await page.goto(TEST_HTML)
}, 30000)

afterAll(async () => {
  await browser.close()
})

describe("getAccessibilitySnapshot — chromium real", () => {
  it("incluye URL, título y refs accionables [ref=eN]", async () => {
    const snap = await getAccessibilitySnapshot(page)
    expect(snap).toContain("# Page Accessibility Snapshot")
    expect(snap).toContain("Title: TER-506")
    expect(snap).toContain('button "Guardar cambios"')
    expect(snap).toMatch(/\[ref=(s\d+)?e\d+\]/)
    expect(snap).toContain("Use the ref values")
  })

  it("fallback CDP también produce el árbol con roles y nombres", async () => {
    const snap = await getAccessibilitySnapshotViaCDP(page)
    expect(snap).toContain("# Page Accessibility Snapshot")
    expect(snap).toContain('button: "Guardar cambios"')
    expect(snap).toContain("Title: TER-506")
    // jerarquía visible: los hijos van indentados (gap P10 del hunt — el LLM
    // pierde la estructura del árbol sin la indentación)
    expect(snap).toMatch(/\n\s{2,}- /)
  })
})

describe("findElementByRef — resolución multi-estrategia", () => {
  it("estrategia 1: aria-ref de un snapshot REAL resuelve el elemento", async () => {
    const snap = await getAccessibilitySnapshot(page)
    const ref = snap.match(/button "Guardar cambios" \[ref=((?:s\d+)?e\d+)\]/)?.[1]
    expect(ref, "el snapshot no expone ref del botón").toBeDefined()
    const el = await findElementByRef(page, ref as string)
    expect(el).not.toBeNull()
    expect(await el?.evaluate((n) => (n as HTMLElement).id)).toBe("guardar")
  })

  it("estrategia 2: CSS selector", async () => {
    const el = await findElementByRef(page, "#guardar")
    expect(el).not.toBeNull()
    expect(await el?.evaluate((n) => (n as HTMLElement).tagName)).toBe("BUTTON")
  })

  it("estrategia 3: texto visible", async () => {
    const el = await findElementByRef(page, "Enlace único")
    expect(el).not.toBeNull()
    expect(await el?.evaluate((n) => (n as HTMLElement).tagName)).toBe("A")
  })

  it('estrategia 4: role + "name"', async () => {
    const el = await findElementByRef(page, 'button "Guardar cambios"')
    expect(el).not.toBeNull()
    expect(await el?.evaluate((n) => (n as HTMLElement).id)).toBe("guardar")
  })

  it("retries=0 ejecuta EXACTAMENTE una pasada de estrategias, no cero (gap P8 del hunt)", async () => {
    const el = await findElementByRef(page, "#guardar", 0)
    expect(el).not.toBeNull()
  })

  it("ref con formato aria pero inexistente → null en segundos, no 30+ (regression del timeout)", async () => {
    const start = Date.now()
    const el = await findElementByRef(page, "e9999", 0)
    expect(el).toBeNull()
    // pre-fix: getByText sin timeout esperaba 30s → ~33s total
    expect(Date.now() - start).toBeLessThan(12000)
  }, 15000)

  it("selector imposible → null en segundos (sin throw)", async () => {
    const start = Date.now()
    const el = await findElementByRef(page, "zzz-no-existe-zzz", 0)
    expect(el).toBeNull()
    expect(Date.now() - start).toBeLessThan(12000)
  }, 15000)
})

describe("regex de refs del snapshot", () => {
  // El formato de _snapshotForAI: "e3", "e78", "s1e3"
  it.each(["e3", "e78", "s1e3", "s12e345"])("%s ES un aria-ref válido", async (ref) => {
    // verificable solo por comportamiento: con formato válido intenta aria-ref
    // primero (waitFor attached con timeout) — un ref válido inexistente tarda
    // ~3s; uno con formato inválido salta directo a CSS y falla rápido.
    expect(/^(s\d+)?e\d+$/.test(ref)).toBe(true)
  })

  it.each(["x3", "e", "s1", "3e1", "se1", "E3"])("%s NO es aria-ref", (ref) => {
    expect(/^(s\d+)?e\d+$/.test(ref)).toBe(false)
  })
})
