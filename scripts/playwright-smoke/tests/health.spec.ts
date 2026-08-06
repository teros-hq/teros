import { capturedErrors, expect, test } from "../fixtures"
import { CONFIG } from "../helpers/config"
import { getClientState } from "../helpers/teros"

test.describe("health @health", () => {
  test("app cargada, sidebar renderiza, sin errores JS", async ({ terosPage, seed }) => {
    // App loaded = the live client responds (robust, language-agnostic).
    const state = await getClientState(terosPage)
    expect(state.ok, `window.teros: ${(state as { reason?: string }).reason}`).toBe(true)
    expect((state as { workspaces: number }).workspaces).toBeGreaterThan(0)

    // Logged in (not stuck on /login).
    expect(terosPage.url()).not.toContain("/login")

    // Sidebar rendered — any known section (ES or EN), web-first assertion.
    const body = await terosPage.locator("body").innerText()
    expect(body).toMatch(/AGENT|PROYECTO|PROJECT|CONVERSATION|APPS/i)

    // Seed fixtures present (sanity that we're on the seeded data).
    expect(seed.user1.userId).toBeTruthy()

    // No JS console / page errors. Network 4xx (avatar 404) are reported but don't fail.
    const errs = capturedErrors(terosPage)
    if (errs.network.length)
      console.log(`⚠️  network 4xx/5xx: ${[...new Set(errs.network)].join(", ")}`)
    expect(errs.console, errs.console.join("\n")).toEqual([])
    expect(errs.page, errs.page.join("\n")).toEqual([])
  })

  // Deploy gate (#218): /health is a public HTTP route that probes critical deps.
  // A broken deploy must fail it, so it must return 200 + status:"ok" when healthy.
  test("/health responde 200 con status ok", async ({ request }) => {
    const res = await request.get(`${CONFIG.backendUrl}/health`)
    expect(res.status()).toBe(200)
    expect((await res.json()).status).toBe("ok")
  })
})
