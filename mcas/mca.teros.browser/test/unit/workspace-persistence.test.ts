/**
 * Regresión fb_caf71ae2958c312a + fb_308df10c8279a762 (2026-10-31):
 * screenshots/videos deben aterrizar en /workspace ADEMÁS del object store,
 * y stop-recording debe leer el buffer ANTES de borrar el temp (write-then-
 * delete) — el 29MB de review-session-01 se dio por destruido porque el
 * código WS1c solo escribía al object store y el temp se unlinkeaba igual.
 *
 * Parte unitaria: resolveWorkspacePath/writeToWorkspace con MCA_WORKSPACE_PATH
 * apuntando a un tmpdir (workspaceRoot() lee el env por llamada).
 * Parte real: chromium graba en tmpdir → close → video.path() existe →
 * writeToWorkspace lo aterriz — la secuencia exacta del handler.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Browser, chromium } from "playwright"
import {
  resolveWorkspacePath,
  workspaceRoot,
  writeToWorkspace,
} from "../../src/workspace-persistence"

const TMP = mkdtempSync(join(tmpdir(), "pw-ws-test-"))
const WS = join(TMP, "workspace")
const VIDEOS = join(WS, "videos")

beforeAll(() => {
  process.env.MCA_WORKSPACE_PATH = WS
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

describe("resolveWorkspacePath — política de rutas", () => {
  it("vacío → <root>/videos/<default> (stop-recording sin filename)", () => {
    expect(resolveWorkspacePath(undefined, "videos", "out.webm")).toBe(
      join(WS, "videos", "out.webm"),
    )
    expect(resolveWorkspacePath("", "videos", "out.webm")).toBe(join(WS, "videos", "out.webm"))
  })

  it("relativo → <root>/<name> (respeta subdirectorios)", () => {
    expect(resolveWorkspacePath("shots/x.png", "", "d.png")).toBe(join(WS, "shots/x.png"))
  })

  it("absoluto dentro del root → tal cual", () => {
    expect(resolveWorkspacePath(join(WS, "a.png"), "", "d.png")).toBe(join(WS, "a.png"))
  })

  it("absoluto fuera del root → re-root por basename (el contenedor solo ve /workspace)", () => {
    expect(resolveWorkspacePath("/etc/passwd", "videos", "d.webm")).toBe(
      join(WS, "videos", "passwd"),
    )
  })

  it("root por defecto /workspace cuando no hay env", () => {
    delete process.env.MCA_WORKSPACE_PATH
    expect(workspaceRoot()).toBe("/workspace")
    process.env.MCA_WORKSPACE_PATH = WS
  })
})

describe("writeToWorkspace — best-effort con error visible (no-empty-catch)", () => {
  it("escribe el buffer y el archivo existe", async () => {
    const buf = Buffer.from("png-fake-bytes")
    const r = await writeToWorkspace(buf, join(WS, "shot.png"))
    expect(r.ok).toBe(true)
    expect(statSync(r.path).size).toBe(buf.length)
  })

  it("fallo → ok:false + error en el resultado (nunca throw, nunca silencio)", async () => {
    // /dev/null/x es ENOENT garantizado dentro del catch
    const r = await writeToWorkspace(Buffer.from("x"), "/dev/null/x/y.png")
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })
})

describe("flujo real record→stop con chromium (secuencia del handler)", () => {
  let browser: Browser

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] })
  }, 30000)

  afterAll(async () => {
    await browser.close()
  })

  it("video.path() existe tras close → buffer se lee → writeToWorkspace aterriza ANTES de cualquier unlink", async () => {
    const tempDir = join(TMP, "pw-videos")
    const context = await browser.newContext({
      recordVideo: { dir: tempDir, size: { width: 320, height: 240 } },
    })
    const page = await context.newPage()
    await page.goto("data:text/html,<h1>fb-regression</h1>")
    await page.waitForTimeout(300)
    const video = page.video()
    await page.close()
    const tempPath = await video!.path()
    await context.close()

    // 1. el temp existe (como el webm que crecía en /workspace/videos)
    const tempBuf = readFileSync(tempPath)
    expect(tempBuf.length).toBeGreaterThan(0)

    // 2. write-then-delete: primero la copia durable, después el unlink
    const r = await writeToWorkspace(tempBuf, join(VIDEOS, "regression-check.webm"))
    expect(r.ok).toBe(true)
    expect(statSync(join(VIDEOS, "regression-check.webm")).size).toBe(tempBuf.length)

    // 3. solo ahora se borra el temp (el bug de 2026-10-31 lo borraba igual con la copia rota)
    expect(statSync(tempPath).size).toBe(tempBuf.length)
  })
})
