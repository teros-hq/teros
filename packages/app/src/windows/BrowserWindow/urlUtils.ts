/**
 * URL helpers for the Browser window (Plan A) — pure functions, no React,
 * unit-tested in BrowserWindowContent.render.test.tsx.
 *
 * Plan A is honest about being a URL *viewer*: input that doesn't look like
 * a URL is rejected (null) rather than guessed into a search query — having
 * no default search engine is a product decision, not an oversight.
 */

/** Has an explicit transport scheme (`https://`, `http://`, `ftp://`…) or
 *  `mailto:`. Deliberately NOT the permissive `^[a-z]+:` — that would swallow
 *  `example.com:8080` (a port) as a "scheme" and break the URL. */
const HAS_SCHEME_RE = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/|mailto:)/i

/** Looks like a bare domain: `example.com`, `raw-os.teros.ai`… (leading part
 *  of the input; a port/path/query may follow). */
const DOMAIN_RE = /^[\w-]+(?:\.[\w-]+)+/

/** `localhost` / `localhost:3000` — no dot, but still a host. */
const LOCALHOST_RE = /^localhost(?::\d+)?(?:\/|$)/i

/**
 * Normalize raw URL-bar input into a navigable URL:
 *  - already has a scheme → as-is
 *  - scheme-less but looks like a domain or localhost → `https://` prepended
 *  - anything else (free text, single words, paths) → null — not a URL
 */
export function normalizeUrlInput(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (HAS_SCHEME_RE.test(trimmed)) return trimmed
  if (DOMAIN_RE.test(trimmed) || LOCALHOST_RE.test(trimmed)) {
    return `https://${trimmed}`
  }
  return null
}

/** Hostname of a URL; null when absent or unparseable. */
export function hostnameOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

/**
 * Best-effort canonical form of a `url` prop: normalized when it looks like
 * a domain, passed through as-is otherwise (a weird-but-real URL shouldn't
 * be dropped — the iframe simply fails to load and the embed hint takes
 * over). Undefined stays undefined.
 */
export function canonicalUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  return normalizeUrlInput(url) ?? url
}

// ─── Desktop address bar (DBAB) ──────────────────────────────────────────────
// The native browser window (Teros Desktop) resolves free text into a search
// instead of rejecting it. Plan A keeps `normalizeUrlInput` as-is.

/** @spec DBAB-REQ-2 — the default search engine (one constant in v1). */
export const SEARCH_ENGINE = {
  id: "perplexity",
  name: "Perplexity",
  /** `%s` is replaced by the percent-encoded query. */
  template: "https://www.perplexity.ai/search?q=%s",
} as const

/** @spec DBAB-REQ-2 — search URL for a free-text query on the default engine. */
export function searchUrl(query: string): string {
  return SEARCH_ENGINE.template.replace("%s", encodeURIComponent(query.trim()))
}

export type AddressResolution =
  | { kind: "url"; url: string }
  | { kind: "search"; url: string; query: string }

/** `about:blank` and friends — a scheme without `//` that is still a URL. */
const ABOUT_RE = /^about:/i

/**
 * @spec DBAB-REQ-1 — resolve what was typed in the address bar:
 *  - empty → null (nothing to do)
 *  - explicit scheme (`https://`, `mailto:`, `about:` …) → as-is
 *  - no whitespace and host-shaped (domain, IPv4, localhost) → `https://` prepended
 *  - anything else → a search on the default engine
 */
export function resolveAddressInput(input: string): AddressResolution | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (HAS_SCHEME_RE.test(trimmed) || ABOUT_RE.test(trimmed)) return { kind: "url", url: trimmed }
  if (!/\s/.test(trimmed)) {
    const asUrl = normalizeUrlInput(trimmed)
    if (asUrl) return { kind: "url", url: asUrl }
  }
  return { kind: "search", url: searchUrl(trimmed), query: trimmed }
}

// ─── Suggestions (DBAB-REQ-11) ──────────────────────────────────────────────

/** The shell's answer to a suggest query (mirror of desktopBridge.ts). */
export interface SuggestSource {
  query: string
  history: { url: string; title: string }[]
  completions: string[]
}

/** One row of the suggestion list under the address field. */
export interface SuggestionRow {
  /** 'resolve' is always row 1: what Enter does with the draft as typed. */
  kind: "resolve" | "history" | "completion"
  /** Primary text (the draft, the page title, the completion). */
  label: string
  /** Secondary text ("Go to host", the URL, "Search Perplexity"). */
  detail: string
  /** Where picking the row navigates. */
  url: string
}

export const MAX_SUGGESTION_ROWS = 8
const MAX_HISTORY_ROWS = 3
const MAX_COMPLETION_ROWS = 5

/**
 * @spec DBAB-REQ-11 — the rows for a draft: row 1 is the draft's own
 * resolution (REQ-1), then history matches, then provider completions; at
 * most MAX_SUGGESTION_ROWS. `source` is ignored unless it answers THIS draft
 * (stale answers never show, REQ-13). Empty draft → no rows.
 */
export function buildSuggestionRows(draft: string, source: SuggestSource | null): SuggestionRow[] {
  const resolved = resolveAddressInput(draft)
  if (!resolved) return []
  const trimmed = draft.trim()
  const rows: SuggestionRow[] = [
    resolved.kind === "url"
      ? { kind: "resolve", label: trimmed, detail: `Go to ${displayUrl(resolved.url)}`, url: resolved.url }
      : { kind: "resolve", label: trimmed, detail: `Search ${SEARCH_ENGINE.name}`, url: resolved.url },
  ]
  if (!source || source.query.trim() !== trimmed) return rows
  const seen = new Set<string>([resolved.url])
  for (const h of source.history.slice(0, MAX_HISTORY_ROWS)) {
    if (!h?.url || seen.has(h.url)) continue
    seen.add(h.url)
    rows.push({ kind: "history", label: h.title || displayUrl(h.url), detail: displayUrl(h.url), url: h.url })
  }
  let completions = 0
  for (const c of source.completions) {
    if (rows.length >= MAX_SUGGESTION_ROWS || completions >= MAX_COMPLETION_ROWS) break
    const text = typeof c === "string" ? c.trim() : ""
    if (!text || text.toLowerCase() === trimmed.toLowerCase()) continue
    const url = searchUrl(text)
    if (seen.has(url)) continue
    seen.add(url)
    rows.push({ kind: "completion", label: text, detail: `Search ${SEARCH_ENGINE.name}`, url })
    completions += 1
  }
  return rows.slice(0, MAX_SUGGESTION_ROWS)
}

/**
 * @spec DBAB-REQ-4 — the URL as the unfocused field shows it: no leading
 * `https://`, no trailing `/` when it is the whole path. Everything else
 * (other schemes, query, fragment) stays visible.
 */
export function displayUrl(url: string): string {
  if (!url) return ""
  let out = url.replace(/^https:\/\//i, "")
  if (/^[^/?#]+\/$/.test(out)) out = out.slice(0, -1)
  return out
}
