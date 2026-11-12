/**
 * What a blocked session asks, read from its screen. The sessions stream only
 * says "blocked" (plus the hook's message); the question and its numbered
 * options are on screen, so each block is read once with terminal.screen and
 * parsed like the chat card's tool results (needsYou.ts). Shared by every
 * surface showing the same session: one fetch per question (terminalId + the
 * block's `at`), never on watcher/typing events.
 */

import { useEffect, useSyncExternalStore } from "react"
import { getTerosClient } from "../../services/terosClientSingleton"
import type { TerminalSession } from "../../windows/TerminalWindow/terminalSessions"
import { parseTerminalQuestion, type TerminalQuestion } from "../mca/renderers/terminal/needsYou"
import { isBlocked, needKey } from "./terminalNeeds"

interface ScreenResponse {
  screen?: { lines?: string[] } | null
  question?: string | null
}

type Fetch = (terminalId: string) => Promise<ScreenResponse>

const cache = new Map<string, TerminalQuestion>()
const inFlight = new Set<string>()
const listeners = new Set<() => void>()
let version = 0
/** A dialog drawn a moment after the hook fired: one more look when the first had no options. */
const RETRY_MS = 1200
const MAX_CACHED = 64

function emit(): void {
  version++
  for (const l of listeners) l()
}

const screenOf: Fetch = async (terminalId) => {
  const client = getTerosClient()
  if (!client) throw new Error("not connected")
  return (await client.send("terminal", "screen", { terminalId })) as ScreenResponse
}

/** Only an awake session is read: looking must not wake a sleeping or frozen one. */
export function canReadScreen(s: TerminalSession): boolean {
  return isBlocked(s) && (s.lifecycle === undefined || s.lifecycle === "awake")
}

/** The question without its screen: the hook's message, no options. */
export function fallbackQuestion(s: TerminalSession): TerminalQuestion {
  return parseTerminalQuestion(null, s.agentState?.message ?? null)
}

/** Read (once) and parse the screen of a blocked session; resolves when cached. */
export async function loadScreenQuestion(
  s: TerminalSession,
  fetchScreen: Fetch = screenOf,
  retryMs = RETRY_MS,
): Promise<void> {
  const key = needKey(s)
  if (cache.has(key) || inFlight.has(key) || !canReadScreen(s)) return
  inFlight.add(key)
  try {
    const hint = s.agentState?.message ?? null
    let q: TerminalQuestion | null = null
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, retryMs))
      const res = await fetchScreen(s.terminalId)
      q = parseTerminalQuestion((res.screen?.lines ?? []).join("\n"), res.question ?? hint)
      if (q.options.length) break
    }
    if (q) remember(key, q)
  } catch {
    // Not readable now (ended, no access): the card keeps the hook's message.
  } finally {
    inFlight.delete(key)
  }
}

function remember(key: string, q: TerminalQuestion): void {
  cache.set(key, q)
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string)
  emit()
}

/** The cached question of a session's current block, if read. */
export function cachedScreenQuestion(s: TerminalSession): TerminalQuestion | undefined {
  return cache.get(needKey(s))
}

/** For tests. */
export function resetScreenQuestions(): void {
  cache.clear()
  inFlight.clear()
  emit()
}

/** What a blocked session asks: its screen's question and options, else the hook's message. */
export function useScreenQuestion(
  session: TerminalSession | null | undefined,
): TerminalQuestion | null {
  const key = session ? needKey(session) : null
  const readable = !!session && canReadScreen(session)
  // biome-ignore lint/correctness/useExhaustiveDependencies: key stands in for the session; only a new block (or waking up) reads again
  useEffect(() => {
    if (session && readable) void loadScreenQuestion(session)
  }, [key, readable])
  useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => version,
  )
  if (!session || !isBlocked(session)) return null
  return cachedScreenQuestion(session) ?? fallbackQuestion(session)
}
