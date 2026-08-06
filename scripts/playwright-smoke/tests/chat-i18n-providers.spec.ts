/**
 * i18n of the "My Providers" window (#239, rama fix/i18n-en-ventana-de-proveedores).
 *
 * Bug: ~15 hardcoded English strings (status badges, the DEFAULT badge, the
 * 'N model(s)' counter, 'Last tested:', 'Set as Default', 'Test'/'Testing') shown
 * even with the app in Spanish/Korean. Fix: every string moved to `t('providers.*')`.
 *
 * Render approach (the right layer for a presentation i18n bug): open the window
 * with the browser locale forced to es-ES (expo-localization picks it up), click
 * the "Proveedores" sidebar entry to open the window, then assert the Spanish
 * strings are present AND the English originals are gone. The seed agent carries
 * a `teros`/Kimi provider, so a ProviderCard with a status badge actually renders.
 *
 * Mutation check: revert one t('providers.statusActive') back to the literal
 * 'Active' (or t('providers.modelCount') to 'model(s)') in ProvidersWindowContent
 * (Metro re-bundles) → the English string reappears → the toContain('activo') /
 * not.toContain('model(s)') assertion goes red.
 */
import { expect, test } from "../fixtures"
import { CONFIG } from "../helpers/config"

test.describe("i18n — ventana My Providers en español (#239) @security", () => {
  test("los textos de proveedores se muestran en español, no en inglés", async ({ browser }) => {
    // Dedicated es-ES context (own storageState so it's authenticated as user1).
    const context = await browser.newContext({
      storageState: `${CONFIG.authDir}/user1.json`,
      locale: "es-ES",
      viewport: { width: 1280, height: 900 },
    })
    const page = await context.newPage()
    try {
      // Land authenticated (es-ES locale → app detects Spanish), open the window
      // by clicking the localized "Proveedores" sidebar entry (the /providers route
      // alone normalizes back to /chat in the tiling shell).
      await page.goto(CONFIG.targetUrl, { waitUntil: "networkidle", timeout: 30000 })
      await page.waitForTimeout(2500)
      await page.locator("text=Proveedores").first().click({ timeout: 8000 })
      await page.waitForTimeout(3000)

      const body = (await page.locator("body").innerText()).toLowerCase()
      // The window rendered a ProviderCard (seed adds teros/Kimi).
      expect(body, "la ventana de proveedores cargó (Teros/Kimi)").toContain("teros")

      // Spanish strings the #239 fix introduced: the status badge ('Activo') and
      // the model counter ('N modelo(s)' instead of 'N model(s)').
      expect(body, "el badge de estado está en español ('activo')").toContain("activo")
      expect(body, "el contador de modelos está en español ('modelo')").toContain("modelo")

      // English originals must be GONE (the regression). 'model(s)' is the exact
      // English plural the counter used; the standalone English 'active' badge too.
      expect(body, "no debe quedar el contador inglés 'model(s)'").not.toContain("model(s)")
      expect(body, "no debe quedar 'set as default' en inglés").not.toContain("set as default")
      expect(body, "no debe quedar 'last tested' en inglés").not.toContain("last tested")
    } finally {
      await context.close()
    }
  })
})
