/**
 * i18n test — "Help improve Teros" consent copy (task_047a4844b9103db3).
 *
 * The Profile toggle must be visible and honest in ALL three supported
 * locales. Honesty rule (Pablo, 2026-10-26): anonymized ≠ not stored — the
 * copy must say the data is anonymized and must NOT promise that nothing is
 * stored. This test pins both properties per language:
 *   - every profile.improveTeros.* key exists and is non-empty;
 *   - the sub copy mentions anonymization (es: anonimizadas, en: anonymized,
 *     ko: 익명화);
 *   - the sub copy does not claim "nothing is stored" (spot the classic
 *     weasel phrases and fail if they appear).
 *
 *   cd packages/app && bun test src/i18n/improveTeros.i18n.test.ts
 */
import { describe, expect, it } from "bun:test"
import esES from "./locales/es-ES.json"
import enUS from "./locales/en-US.json"
import koKR from "./locales/ko-KR.json"

const REQUIRED_KEYS = ["section", "title", "sub", "on", "off", "error"] as const

/**
 * Minimal structural type for what this test actually reads:
 * profile.improveTeros.{section,title,sub,on,off,error}. A full `typeof esES`
 * here would demand structural parity of the WHOLE bundle across locales —
 * that is a real debt (ko-KR trails es-ES by ~500 keys) but it is NOT this
 * test's concern, and it made tsc fail on unrelated drift (TS2719/TS2741,
 * CI run 40383055553). Keep the type narrow and honest.
 */
type ImproveTerosBundle = {
  profile: { improveTeros: Record<(typeof REQUIRED_KEYS)[number], string> }
}

/** Per-language marker that the copy says the data is anonymized. */
const ANONYMIZED_MARKER: Record<string, RegExp> = {
  "es-ES": /anonimizad/i,
  "en-US": /anonymized/i,
  "ko-KR": /익명화/,
}

/** Phrases that would dishonestly imply "nothing is stored". */
const WEASEL_PHRASES: Record<string, RegExp[]> = {
  "es-ES": [/no se almacena nada/i, /no guardamos nada/i],
  "en-US": [/nothing is stored/i, /we don'?t store anything/i],
  "ko-KR": [/아무것도 저장하지 않/],
}

const LOCALES: Record<string, ImproveTerosBundle> = {
  "es-ES": esES,
  "en-US": enUS,
  "ko-KR": koKR,
}

describe("profile.improveTeros i18n (consent copy)", () => {
  for (const [locale, bundle] of Object.entries(LOCALES)) {
    it(`${locale}: has all improveTeros keys, non-empty`, () => {
      const improve = (bundle as any).profile?.improveTeros
      expect(improve, `profile.improveTeros missing in ${locale}`).toBeDefined()
      for (const key of REQUIRED_KEYS) {
        expect(typeof improve[key], `${locale} improveTeros.${key}`).toBe("string")
        expect((improve[key] as string).trim().length, `${locale} improveTeros.${key} empty`).toBeGreaterThan(0)
      }
    })

    it(`${locale}: sub copy says the data is anonymized`, () => {
      const sub = (bundle as any).profile.improveTeros.sub as string
      expect(ANONYMIZED_MARKER[locale].test(sub), `${locale} sub must mention anonymization: "${sub}"`).toBe(true)
    })

    it(`${locale}: sub copy never promises that nothing is stored`, () => {
      const sub = (bundle as any).profile.improveTeros.sub as string
      for (const weasel of WEASEL_PHRASES[locale]) {
        expect(weasel.test(sub), `${locale} sub must not contain "${weasel}": "${sub}"`).toBe(false)
      }
    })
  }
})
