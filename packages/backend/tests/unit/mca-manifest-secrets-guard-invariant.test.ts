/**
 * Structural invariant (lint-as-test): no manifest under `mcas/<id>/manifest.json`
 * may carry a hardcoded secret value in `runtime.systemEnvironment`. This tree ships
 * verbatim to the public repo (WS2/TER-719) — a hardcoded value here is a
 * leaked credential, not a lint nit.
 *
 * The fix pattern is `${SECRET_MCA_<KEY>}`, resolved at spawn time from
 * `.secrets/mcas/<id>/credentials.json` (gitignored) — see
 * mca-manager.spawn-impl.ts:222-231 and the interpolation contract test in
 * mca-spawn-impl.test.ts ("systemEnvironment interpola ${SECRET_MCA_*}...").
 *
 * Detector scope is deliberately narrow: ONLY `runtime.systemEnvironment`
 * values. That is the sole surface where a real secret has ever shipped
 * (mca.whatsapp's WAHA_API_KEY + Bright Data proxy password, sourced during
 * WS2). Scanning the full manifest tree was tried first and false-positived
 * on OAuth scope URLs, ids, and changelog prose — see WS2 handoff. gitleaks
 * (already gated in security.yml) is the broad net for "a secret anywhere in
 * the diff"; this test is the narrow, zero-FP net for "this specific shape,
 * in this specific field, every time the suite runs" — including manifests
 * nobody touched in the current PR, which gitleaks' PR-diff mode would miss.
 *
 * Two independent checks, because neither alone covers the real cases:
 * - CONTENT (`looksLikeHardcodedSecret`): known provider prefixes or a bare
 *   hex token ≥32 chars. Catches WAHA_API_KEY's shape (no prefix, but long
 *   and hex) regardless of what the key is named.
 * - STRUCTURAL (`violatesSecretKeyContract`): any key whose NAME signals a
 *   secret (API_KEY/SECRET/TOKEN/PASSWORD/CREDENTIAL) must have a value that
 *   is a pure `${...}` placeholder — no literal characters allowed at all.
 *   This is the one that actually catches short/low-entropy secrets like
 *   Bright Data's proxy password ("zx7qw2mplk9r", 12 chars): it has no known
 *   prefix and is far too short for the hex check, so content-only detection
 *   misses it — the key name is the only signal available. Verified against
 *   every current systemEnvironment key across all 73 manifests: zero FP.
 */
import { describe, expect, it } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const MCAS_DIR = resolve(__dirname, "../../../../mcas")

// Same interpolation syntax mca-manager.spawn-impl.ts actually resolves
// (ENV_VAR_PATTERN): ${VAR} or bare $VAR. Stripped before the content check so
// a legitimate placeholder is never mistaken for a secret.
const PLACEHOLDER = /\$\{[^}]+\}|\$[A-Z_][A-Z0-9_]*/g

const KNOWN_SECRET_PREFIXES = [
  "GOCSPX-",
  "sk_",
  "sk-",
  "kfy_",
  "ghp_",
  "gho_",
  "ghs_",
  "ghr_",
  "AIza",
  "AKIA",
  "ya29.",
  "xoxb-",
  "xoxp-",
  "xoxa-",
  "xoxr-",
]

/** A bare hex token this long is the WAHA_API_KEY shape: no known prefix, so
 * only length + charset gives it away. 32 hex chars = 128 bits, well past
 * anything a legitimate config literal in systemEnvironment would need. */
const BARE_HEX_SECRET = /[0-9a-f]{32,}/i

const PEM_HEADER = /-----BEGIN [A-Z ]*PRIVATE KEY-----/

export function looksLikeHardcodedSecret(rawValue: string): boolean {
  const residual = rawValue.replace(PLACEHOLDER, "")
  if (PEM_HEADER.test(residual)) return true
  if (KNOWN_SECRET_PREFIXES.some((p) => residual.includes(p))) return true
  if (BARE_HEX_SECRET.test(residual)) return true
  return false
}

/** Key names that mean "this value is a credential" regardless of shape. */
const SECRET_KEY_NAME = /API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL/i

/** A key matching SECRET_KEY_NAME must resolve ENTIRELY via interpolation —
 * no literal characters mixed in (that would mean part of the credential is
 * still hardcoded, e.g. a static prefix concatenated with a dynamic suffix). */
const PURE_PLACEHOLDER = /^(?:\$\{[A-Z0-9_]+\}|\$[A-Z_][A-Z0-9_]*)$/

export function violatesSecretKeyContract(key: string, value: string): boolean {
  return SECRET_KEY_NAME.test(key) && !PURE_PLACEHOLDER.test(value)
}

function manifestFiles(): string[] {
  return readdirSync(MCAS_DIR)
    .map((dir) => resolve(MCAS_DIR, dir, "manifest.json"))
    .filter((f) => existsSync(f))
}

/** `mcas/<id>/manifest.json: <key>` for every systemEnvironment value that
 * fails either detector. Empty when the tree is clean. */
function findManifestSecretViolations(files: string[]): string[] {
  const violations: string[] = []
  for (const file of files) {
    const manifest = JSON.parse(readFileSync(file, "utf-8"))
    const env = manifest?.runtime?.systemEnvironment
    if (!env || typeof env !== "object") continue
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== "string") continue
      if (looksLikeHardcodedSecret(value) || violatesSecretKeyContract(key, value)) {
        violations.push(`${file.replace(MCAS_DIR, "mcas")}: ${key}`)
      }
    }
  }
  return violations
}

describe("mca manifest secrets guard (WS2/TER-719)", () => {
  it("content detector: red for secret shapes, green for the literals that legitimately appear in systemEnvironment today", () => {
    // Mutation proof — flip any of these and the test goes red. Synthetic
    // fixture, NOT the real WAHA_API_KEY (never hardcode the real value here —
    // that would defeat the whole point of WS2).
    expect(looksLikeHardcodedSecret("aa11bb22cc33dd44ee55ff660011223344556677")).toBe(true) // WAHA_API_KEY shape: bare hex, no prefix
    expect(looksLikeHardcodedSecret("GOCSPX-abcDEF123xyz456")).toBe(true)
    expect(looksLikeHardcodedSecret("sk_live_abcdefghijklmnop")).toBe(true)
    expect(looksLikeHardcodedSecret("kfy_abcdefghijklmnop")).toBe(true)
    expect(looksLikeHardcodedSecret("-----BEGIN RSA PRIVATE KEY-----\nMIIE...")).toBe(true)

    // Real, current systemEnvironment literals — must NOT be flagged. These are
    // LITERAL placeholder strings under test, not interpolations.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder syntax under test, not an interpolation
    expect(looksLikeHardcodedSecret("${SECRET_MCA_WAHA_API_KEY}")).toBe(false)
    expect(
      looksLikeHardcodedSecret(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder syntax under test, not an interpolation
        "${SECRET_MCA_WHATSAPP_PROXY_SERVER_USERNAME}-session-${MCA_APP_ID}",
      ),
    ).toBe(false)
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder syntax under test, not an interpolation
    expect(looksLikeHardcodedSecret("${SECRET_MCA_WHATSAPP_PROXY_SERVER_PASSWORD}")).toBe(false)
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder syntax under test, not an interpolation
    expect(looksLikeHardcodedSecret("${DOCKER_ENV_DOMAIN}")).toBe(false)
    expect(looksLikeHardcodedSecret("GOWS")).toBe(false)
    expect(looksLikeHardcodedSecret("/app-data")).toBe(false)
    expect(looksLikeHardcodedSecret("brd.superproxy.io:33335")).toBe(false)
    expect(looksLikeHardcodedSecret("unix:///var/run/docker.sock")).toBe(false)
  })

  it("structural detector: a secret-named key must be a pure placeholder — catches short/low-entropy secrets the content check misses", () => {
    // The load-bearing case: Bright Data's real proxy password was 12 chars,
    // lowercase+digits, no known prefix — looksLikeHardcodedSecret alone
    // (content-only) does NOT catch this shape. Only the key name does.
    expect(violatesSecretKeyContract("WHATSAPP_PROXY_SERVER_PASSWORD", "zx7qw2mplk9r")).toBe(true)
    expect(looksLikeHardcodedSecret("zx7qw2mplk9r")).toBe(false) // proof the content check alone misses it

    expect(violatesSecretKeyContract("WAHA_API_KEY", "plaintext-not-a-placeholder")).toBe(true)
    // A secret-named key mixing a placeholder with literal text is still a partial leak.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder syntax under test, not an interpolation
    expect(violatesSecretKeyContract("API_TOKEN", "${SECRET_MCA_API_TOKEN}-suffix")).toBe(true)

    // Pure placeholders on secret-named keys — must NOT be flagged.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder syntax under test, not an interpolation
    expect(violatesSecretKeyContract("WAHA_API_KEY", "${SECRET_MCA_WAHA_API_KEY}")).toBe(false)
    expect(
      violatesSecretKeyContract(
        "WHATSAPP_PROXY_SERVER_PASSWORD",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder syntax under test, not an interpolation
        "${SECRET_MCA_WHATSAPP_PROXY_SERVER_PASSWORD}",
      ),
    ).toBe(false)

    // Keys whose name doesn't signal "credential" are never constrained by this rule,
    // even if their value is a mixed template + literal string (e.g. sticky-session suffix).
    expect(
      violatesSecretKeyContract(
        "WHATSAPP_PROXY_SERVER_USERNAME",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder syntax under test, not an interpolation
        "${SECRET_MCA_WHATSAPP_PROXY_SERVER_USERNAME}-session-${MCA_APP_ID}",
      ),
    ).toBe(false)
    expect(violatesSecretKeyContract("WHATSAPP_DEFAULT_ENGINE", "GOWS")).toBe(false)
    expect(violatesSecretKeyContract("DOCKER_HOST", "unix:///var/run/docker.sock")).toBe(false)
  })

  it("every mcas/<id>/manifest.json has zero hardcoded secrets in runtime.systemEnvironment", () => {
    const files = manifestFiles()
    // Sanity: guards against a refactor (or a bad glob) silently making this
    // pass vacuously because it stopped finding manifests at all.
    expect(files.length).toBeGreaterThan(50)
    expect(findManifestSecretViolations(files)).toEqual([])
  })
})
