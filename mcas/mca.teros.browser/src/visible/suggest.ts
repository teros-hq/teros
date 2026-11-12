/**
 * Address-bar suggestions for visible tabs (spec BRW-REQ-6 `browser-suggest`;
 * semantics of the desktop browser, DBAB-REQ-13): the user's visit history in
 * this app (in memory) + Google Suggest, never queried for URL-like input.
 */

export const SUGGEST_PROVIDER = {
  id: "google",
  name: "Google Suggest",
  template: "https://suggestqueries.google.com/complete/search?client=firefox&q=%s",
} as const
export const PROVIDER_TIMEOUT_MS = 1_500
export const MAX_HISTORY_ROWS = 3
export const MAX_COMPLETIONS = 5
export const MAX_LOG_ENTRIES = 2_000

const HAS_SCHEME_RE = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:\/\/|mailto:|about:)/i
const DOMAIN_RE = /^[\w-]+(?:\.[\w-]+)+/
const LOCALHOST_RE = /^localhost(?::\d+)?(?:\/|$)/i

export function isUrlLike(input: unknown): boolean {
  const t = String(input ?? "").trim()
  if (!t) return false
  if (HAS_SCHEME_RE.test(t)) return true
  if (/\s/.test(t)) return false
  return DOMAIN_RE.test(t) || LOCALHOST_RE.test(t)
}

export interface HistoryEntry {
  url: string
  title: string
  visits: number
  lastVisitAt: number
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
}

function isLoggable(url: unknown): url is string {
  return typeof url === "string" && /^https?:\/\//i.test(url) && url.length <= 2048
}

export function searchHistory(
  entries: HistoryEntry[],
  query: unknown,
  limit = MAX_HISTORY_ROWS,
): HistoryEntry[] {
  const q = String(query ?? "")
    .trim()
    .toLowerCase()
  if (!q) return []
  const needle = q.replace(/^https?:\/\//, "").replace(/^www\./, "")
  const scored: Array<{ e: HistoryEntry; score: number }> = []
  for (const e of entries) {
    if (!e || typeof e.url !== "string") continue
    const bare = e.url
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
    const title = String(e.title ?? "").toLowerCase()
    let score = 0
    if (bare.startsWith(needle)) score = 3
    else if (hostOf(e.url).includes(needle)) score = 2
    else if (bare.includes(needle) || title.includes(needle)) score = 1
    if (score) scored.push({ e, score })
  }
  scored.sort(
    (a, b) => b.score - a.score || b.e.lastVisitAt - a.e.lastVisitAt || b.e.visits - a.e.visits,
  )
  return scored.slice(0, limit).map(({ e }) => ({
    url: e.url,
    title: e.title || hostOf(e.url),
    visits: e.visits || 1,
    lastVisitAt: e.lastVisitAt || 0,
  }))
}

export class VisitLog {
  private entries = new Map<string, HistoryEntry>()

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly maxEntries = MAX_LOG_ENTRIES,
  ) {}

  recordVisit(url: unknown, title?: string): void {
    if (!isLoggable(url)) return
    const prev = this.entries.get(url)
    const entry: HistoryEntry = prev
      ? { ...prev, visits: prev.visits + 1, lastVisitAt: this.now(), title: title || prev.title }
      : { url, title: title ?? "", visits: 1, lastVisitAt: this.now() }
    this.entries.delete(url)
    this.entries.set(url, entry)
    if (this.entries.size > this.maxEntries) {
      const sorted = [...this.entries.values()].sort((a, b) => b.lastVisitAt - a.lastVisitAt)
      this.entries = new Map(sorted.slice(0, this.maxEntries).map((e) => [e.url, e]))
    }
  }

  retitle(url: string, title: string): void {
    const e = this.entries.get(url)
    if (e && title && e.title !== title) e.title = title
  }

  search(query: unknown, limit?: number): HistoryEntry[] {
    return searchHistory([...this.entries.values()], query, limit)
  }
}

export function parseCompletions(body: unknown, query: unknown, limit = MAX_COMPLETIONS): string[] {
  let data: unknown = body
  if (typeof body === "string") {
    try {
      data = JSON.parse(body)
    } catch {
      return []
    }
  }
  const list = Array.isArray(data) && Array.isArray(data[1]) ? (data[1] as unknown[]) : []
  const q = String(query ?? "")
    .trim()
    .toLowerCase()
  const out: string[] = []
  for (const item of list) {
    if (typeof item !== "string") continue
    const s = item.trim()
    if (!s || s.toLowerCase() === q || out.includes(s)) continue
    out.push(s)
    if (out.length >= limit) break
  }
  return out
}

export type FetchLike = (
  url: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ ok: boolean; text(): Promise<string> }>

export async function fetchCompletions(
  query: unknown,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<string[]> {
  const q = String(query ?? "").trim()
  if (!q || isUrlLike(q)) return []
  const doFetch: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i))
  const url = SUGGEST_PROVIDER.template.replace("%s", encodeURIComponent(q))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? PROVIDER_TIMEOUT_MS)
  try {
    const res = await doFetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    })
    if (!res?.ok) return []
    return parseCompletions(await res.text(), q)
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

export interface SuggestResponse {
  query: string
  history: HistoryEntry[]
  completions: string[]
}

export class SuggestService {
  private logs = new Map<string, VisitLog>()

  constructor(private readonly opts: { fetchImpl?: FetchLike; now?: () => number } = {}) {}

  logFor(userId: string): VisitLog {
    let log = this.logs.get(userId)
    if (!log) {
      log = new VisitLog(this.opts.now)
      this.logs.set(userId, log)
    }
    return log
  }

  async suggest(userId: string, query: unknown): Promise<SuggestResponse> {
    const q = String(query ?? "").trim()
    if (!q) return { query: q, history: [], completions: [] }
    const [history, completions] = await Promise.all([
      Promise.resolve(this.logFor(userId).search(q)),
      fetchCompletions(q, { fetchImpl: this.opts.fetchImpl }),
    ])
    return { query: q, history, completions }
  }
}
