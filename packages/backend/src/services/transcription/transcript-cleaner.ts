/**
 * Transcript Cleaner — post-processing of STT output (voice notes).
 *
 * Cleans filler words, false starts, repetitions, tongue clicks and other
 * disfluencies from a raw speech-to-text transcript BEFORE it reaches the
 * agent — while preserving the exact meaning (this is user input; the
 * cleaner must never summarize, paraphrase content away or drop information).
 *
 * Two cleaning layers:
 * 1. Heuristic layer (always runs first): whitelist-based, deterministic.
 *    Removes unambiguous interjections ("eh", "mmm", "uh"…), known non-speech
 *    markers ("[chasquido]", "(risa)"…), discourse fillers when clearly
 *    parenthetical ("o sea,", "es decir,"…), tag questions ("¿no?", "¿vale?"…)
 *    and immediate duplicated words ("digo, digo"). Real content in
 *    parentheses ("(lo he hecho adrede)") and meaning-bearing words are KEPT.
 * 2. LLM layer (mode 'llm'): one cheap internal-LLM pass (teros-glm-5p3-flash,
 *    credential-free Teros provider) that rewrites the transcript into clean
 *    prose — this is what resolves false starts like Pablo's
 *    "si digo, digo: imagínate que digo algo" → "Si digo algo". Guarded:
 *    timeout, empty-output and length-similarity checks; any failure falls
 *    back to the heuristic-only result.
 *
 * Failure policy: cleaning is best-effort. Any error → the ORIGINAL raw
 * transcript is returned unchanged. The voice flow must never break because
 * cleaning failed.
 */

import { createLogger } from "../../lib/logger"
import type { InternalLLMService } from "../internal-llm-service"

const log = createLogger("TranscriptCleaner")

// ---------------------------------------------------------------------------
// TYPES
// ---------------------------------------------------------------------------

export type TranscriptCleanMode = "heuristic" | "llm"

export interface TranscriptCleanContext {
  userId?: string
  channelId?: string
  messageId?: string
  agentId?: string
}

export interface TranscriptCleanResult {
  /** Cleaned text (or the original when nothing changed / cleaning failed). */
  text: string
  /** Whether any layer actually changed the text. */
  cleaned: boolean
  /** Which layers produced changes. */
  layers: {
    heuristic: boolean
    llm: boolean
  }
  /** Cleaning mode that was applied. */
  mode: TranscriptCleanMode
  /** Wall-clock time spent cleaning, in milliseconds. */
  durationMs: number
}

// ---------------------------------------------------------------------------
// HEURISTIC LAYER — whitelist-based, meaning-safe
// ---------------------------------------------------------------------------

/**
 * Unambiguous interjections/fillers — never content words. Removed when they
 * appear as standalone tokens (surrounded by delimiters), es + en.
 */
const INTERJECTIONS = [
  "eh", "eht", "ehm", "em", "mm", "mmm", "mmh", "mmmh", "hmm",
  "ay", "uf", "uff", "ah", "puh", "pff", "psss",
  "um", "uh", "uhm", "uhh", "erm", "er",
]

/**
 * Discourse fillers — removed ONLY when followed by a comma/colon (clearly
 * parenthetical usage). Meaning-bearing uses ("esto vale mucho") never match.
 */
const DISCOURSE_FILLERS = [
  "o sea", "es decir", "digamos", "bueno pues", "en fin", "pues nada",
  "you know", "i mean",
]

/**
 * Tag questions — removed only when preceded by a comma/colon or whitespace
 * (i.e. attached to previous speech). A standalone "¿vale?" message is kept.
 */
const TAG_QUESTIONS = ["¿no?", "¿vale?", "¿eh?", "¿sabes?", "right?", "okay?", "ok?"]

/**
 * Non-speech markers inside brackets/parens — WHITELIST. Real asides like
 * "(lo he hecho adrede)" are kept; only known sound annotations are removed.
 */
const NONSPEECH_MARKERS = new Set([
  "risa", "risas", "carcajada", "carcajadas", "chasquido", "chasquidos",
  "chasquido de lengua", "click", "clicks", "tos", "tose", "tosiendo",
  "suspiro", "suspira", "suspirando", "silencio", "pausa", "inaudible",
  "ruido", "ruidos", "musica", "aplauso", "aplausos", "respiracion",
  "breath", "cough", "coughs", "laugh", "laughs", "laughter", "sigh",
  "sighs", "pause", "silence", "noise", "music", "applause", "tongue click",
  "tongue clicks",
])

/**
 * Words whose immediate repetition can be legitimate emphasis — never deduped
 * ("muy muy bueno", "sí, sí", "no no"…).
 */
const DUP_KEEP = new Set([
  "si", "sí", "no", "muy", "tan", "ya", "mas", "más", "menos", "bien",
  "mal", "casi", "solo", "sólo", "todo", "toda", "todos", "todas",
  "nada", "nunca", "jamás",
])

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function alternation(words: string[]): string {
  return words.map(escapeRegex).sort((a, b) => b.length - a.length).join("|")
}

/** Standalone interjection: preceded by start/delimiter, followed by delimiter. */
const INTERJECTION_RE = new RegExp(
  `(^|[\\s,;:])(?:${alternation(INTERJECTIONS)})(?=$|[\\s,;:.!?¿¡])`,
  "giu",
)

/** Parenthetical discourse filler: requires the trailing comma/colon. */
const DISCOURSE_RE = new RegExp(
  `(^|[\\s,;:])(?:${alternation(DISCOURSE_FILLERS)})[,;:](?=$|\\s)`,
  "giu",
)

/** Tag question attached to previous speech (never message-initial). */
const TAGQ_RE = new RegExp(
  `([,;:]\\s*|\\s)(?:${alternation(TAG_QUESTIONS)})(?=$|[\\s.!?¿¡])`,
  "giu",
)

/**
 * Sentence-initial fillers — removed ONLY at the very start of the transcript
 * followed by a comma/colon ("Well, ...", "So, ...", "Bueno, ..."). That
 * position is overwhelmingly filler; mid-sentence uses are never touched.
 */
const SENTENCE_INITIAL_FILLERS = ["well", "so", "bueno", "venga"]
const SENT_INITIAL_RE = new RegExp(
  `^\\s*[,;:]*\\s*(?:${alternation(SENTENCE_INITIAL_FILLERS)})[,;:]\\s*`,
  "iu",
)

/** Bracketed/parenthesized short markers: [chasquido], (risa), … */
const NONSPEECH_RE = /\[([^\]\n]{1,40})\]|\(([^)\n]{1,40})\)/g

function normalizeMarker(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z\s]/g, " ")
    .trim()
}

function isNonSpeechMarker(raw: string): boolean {
  const norm = normalizeMarker(raw)
  if (!norm) return false
  if (NONSPEECH_MARKERS.has(norm)) return true
  const words = norm.split(/\s+/)
  return words.length > 0 && words.every((w) => NONSPEECH_MARKERS.has(w))
}

/** Collapse whitespace/punctuation artifacts left by removals. */
function tidy(text: string): string {
  return text
    .replace(/\s*([,;:])\s*(?=[,;:.!?])/g, "") // ", ," / ", :" sequences
    .replace(/\s+([,.;:!?])/g, "$1") // space before punctuation
    .replace(/([,;:])(?=[^\s\d])/g, "$1 ") // ensure space after comma
    .replace(/\(\s*\)/g, "")
    .replace(/\[\s*\]/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.!?¿¡])/g, "$1")
    .replace(/^\s*[,;:.]\s*/, "") // never strip ¿/¡ — standalone questions keep them
    .replace(/\s*[,;:]\s*$/g, "")
    .trim()
}

/**
 * Remove immediate word repetitions ("digo, digo" → "digo") via a token scan:
 * splits into word/separator tokens so chains ("digo, digo, digo") and pairs
 * preceded by other words ("si digo, digo") are deduped correctly. A word is
 * dropped only when it equals the last KEPT word and is not a legitimate
 * emphasis repetition (DUP_KEEP).
 */
function dedupeRepeatedWords(text: string): string {
  const parts = text.split(/([,;:]?[ \t]+)/)
  // parts: [word, sep, word, sep, …] — odd indices are separators.
  const isWord = (s: string | undefined) => (s ? /^[\p{L}][\p{L}']*$/u.test(s) : false)
  let lastKept = 0
  for (let i = 2; i < parts.length; i += 2) {
    const prev = parts[lastKept]
    const cur = parts[i]
    if (!isWord(prev) || !isWord(cur)) {
      if (isWord(cur)) lastKept = i
      continue
    }
    if (prev.toLowerCase() !== cur.toLowerCase()) {
      lastKept = i
      continue
    }
    if (DUP_KEEP.has(cur.toLowerCase())) {
      lastKept = i
      continue
    }
    // Drop the repeated word and the separator that precedes it.
    parts[i] = ""
    parts[i - 1] = ""
  }
  return parts.join("")
}

/**
 * Deterministic, meaning-safe cleaning pass. Never throws on regular input;
 * returns the input unchanged when nothing matches.
 */
export function heuristicClean(input: string): string {
  if (!input || !input.trim()) return input
  let text = input

  // 1. Known non-speech markers ([chasquido], (risa)…) — whitelist only.
  text = text.replace(NONSPEECH_RE, (match, br: string | undefined, par: string | undefined) => {
    const inner = br ?? par ?? ""
    return isNonSpeechMarker(inner) ? " " : match
  })

  // 2. Parenthetical discourse fillers ("o sea," "es decir,"…).
  text = text.replace(DISCOURSE_RE, (_m, pre: string) => pre)

  // 3. Tag questions attached to previous speech ("…, ¿no?").
  text = text.replace(TAGQ_RE, (_m, pre: string) => pre)

  // 4. Standalone interjections — repeat: chains like "eh, mmm" expose new tokens.
  for (let i = 0; i < 3; i++) {
    const next = text.replace(INTERJECTION_RE, (_m, pre: string) => pre)
    if (next === text) break
    text = next
  }

  // 4b. Sentence-initial fillers ("Well, ...", "Bueno, ...") — run AFTER the
  // interjection pass so chains like "uh, well, I think" expose "well" at the
  // start. Repeated: "well, so, I think" needs two passes.
  for (let i = 0; i < 3; i++) {
    const next = text.replace(SENT_INITIAL_RE, "")
    if (next === text) break
    text = next
  }

  // 5. Immediate duplicated words ("digo, digo", "the the") — token scan so
  // chains and preceding words ("si digo, digo") are handled correctly.
  // Emphasis words (DUP_KEEP) are never deduped.
  text = dedupeRepeatedWords(text)

  return tidy(text)
}

// ---------------------------------------------------------------------------
// LLM LAYER
// ---------------------------------------------------------------------------

/** Hard cap on transcript length sent to the LLM (voice notes are short). */
const MAX_LLM_INPUT_CHARS = 4000
/** Max output tokens for the cleaning pass. */
const LLM_MAX_TOKENS = 1500
/** Wall-clock timeout for the LLM pass — beyond this we ship the heuristic result. */
const LLM_TIMEOUT_MS = 6000

const CLEAN_SYSTEM_PROMPT = `You repair raw speech-to-text transcripts. You receive a verbatim transcript of a voice note that may contain filler words, false starts, stutters, repeated words, tongue clicks written as [chasquido]/(click), and abandoned sentence beginnings.

Rewrite it as the clean version of EXACTLY what the speaker meant to say.

ABSOLUTE RULES:
- Same language as the transcript (Spanish stays Spanish, English stays English).
- Keep ALL information, names, numbers, questions and instructions. NEVER summarize, NEVER omit content, NEVER add content, NEVER answer or react.
- Remove only: fillers ("eh", "mmm", "o sea" when pure filler), stutters/repeated words, false starts and abandoned attempts, non-speech markers ([risa], [chasquido], (inaudible)...).
- When the speaker restates something, keep only the final complete statement.
- Keep real parenthetical asides that carry meaning, e.g. "(lo he hecho adrede)".
- Fix only obvious transcription slips needed for the sentence to read naturally; do not restyle the speaker's wording.
- Output ONLY the cleaned transcript text — no quotes, no explanations, no markdown.`

function cleanPrompt(raw: string): string {
  return `Clean transcript (verbatim, may contain disfluencies):

${raw.slice(0, MAX_LLM_INPUT_CHARS)}

Cleaned transcript:`
}

/**
 * Similarity guard: the LLM output must be a plausible cleaning of the input,
 * not a hallucinated answer. We compare information-carrying content words
 * (lowercased, accent-folded, stopwords removed): every content word of the
 * OUTPUT must exist in the INPUT (no invented facts). We do NOT require the
 * reverse — the cleaner legitimately drops fillers and false-start words.
 */
const STOPWORDS = new Set([
  "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "al",
  "a", "ante", "bajo", "con", "contra", "desde", "en", "entre", "hacia",
  "para", "por", "segun", "sin", "sobre", "tras", "y", "e", "o", "u",
  "que", "se", "su", "sus", "lo", "le", "les", "me", "te", "nos",
  "es", "esta", "está", "estan", "están", "fue", "ser", "haber", "ha",
  "he", "han", "hay", "muy", "ya", "no", "ni", "pero", "como", "mas",
  "más", "the", "a", "an", "of", "to", "in", "on", "for", "with",
  "and", "or", "is", "are", "was", "were", "be", "been", "it", "its",
  "this", "that", "these", "those", "i", "you", "he", "she", "we",
  "they", "my", "your", "his", "her", "our", "their", "do", "does",
  "did", "have", "has", "had", "not", "as", "at", "by", "from",
])

function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
}

/**
 * Returns true when the LLM output is an acceptable cleaning of the input:
 * no invented content words, and not absurdly shorter/longer than the input.
 */
export function isPlausibleClean(raw: string, output: string): boolean {
  if (!output || !output.trim()) return false
  const rawWords = contentWords(raw)
  const outWords = contentWords(output)
  if (outWords.length === 0) {
    // Output with no content words is only valid when the raw had none either.
    return rawWords.length === 0
  }
  if (rawWords.length > 0) {
    const rawSet = new Set(rawWords)
    const invented = outWords.filter((w) => !rawSet.has(w))
    // Allow a tiny margin for morphology fixes ("hacer"→"hago"), but any
    // significant invention means the model answered/reacted — reject.
    if (invented.length > Math.max(1, Math.floor(outWords.length * 0.15))) return false
  }
  // Length sanity: a cleaner never produces something 5x longer than the raw.
  if (output.length > raw.length * 5 + 200) return false
  return true
}

// ---------------------------------------------------------------------------
// SERVICE
// ---------------------------------------------------------------------------

export interface TranscriptCleanerDeps {
  /** Optional internal LLM (cheap credential-free Teros provider). */
  internalLLM?: InternalLLMService | null
}

export class TranscriptCleaner {
  constructor(private deps: TranscriptCleanerDeps = {}) {}

  /**
   * Clean a raw STT transcript.
   *
   * @param raw        raw transcript from the STT provider
   * @param mode       'heuristic' (regex only) or 'llm' (heuristic + LLM rewrite)
   * @param context    optional ids for logging
   */
  async clean(
    raw: string,
    mode: TranscriptCleanMode,
    context?: TranscriptCleanContext,
  ): Promise<TranscriptCleanResult> {
    const startedAt = Date.now()
    const base: TranscriptCleanResult = {
      text: raw,
      cleaned: false,
      layers: { heuristic: false, llm: false },
      mode,
      durationMs: 0,
    }

    if (!raw || !raw.trim()) return base

    try {
      // Layer 1 — heuristic (always).
      let text = heuristicClean(raw)
      const heuristicChanged = text !== raw
      if (heuristicChanged) base.layers.heuristic = true

      // Layer 2 — LLM rewrite (mode 'llm').
      if (mode === "llm" && this.deps.internalLLM) {
        try {
          const llmOut = await this.runLLMPass(text)
          if (llmOut !== null && isPlausibleClean(text, llmOut) && llmOut !== text) {
            text = llmOut
            base.layers.llm = true
          }
        } catch (err) {
          // Timeout / provider error → keep heuristic result (never block voice).
          log.warn(
            { err, messageId: context?.messageId, channelId: context?.channelId },
            "Transcript LLM cleaning failed — using heuristic result",
          )
        }
      }

      base.text = text
      base.cleaned = text !== raw
      base.durationMs = Date.now() - startedAt
      return base
    } catch (err) {
      // Absolute failure policy: the raw transcript is user input — never lose it.
      log.error({ err, messageId: context?.messageId }, "Transcript cleaning crashed — returning raw transcript")
      base.durationMs = Date.now() - startedAt
      return base
    }
  }

  /**
   * One LLM pass with a hard timeout. Returns null when the pass must be
   * discarded (timeout, empty output). Throws only on unexpected internals —
   * the caller treats any throw as "keep heuristic result".
   */
  private async runLLMPass(text: string): Promise<string | null> {
    const llm = this.deps.internalLLM
    if (!llm) return null

    const result = await Promise.race([
      llm.generateText(cleanPrompt(text), {
        maxTokens: LLM_MAX_TOKENS,
        systemPrompt: CLEAN_SYSTEM_PROMPT,
        // TLANE-REQ-4: the voice note waits on this before reaching the agent.
        lane: "interactive",
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), LLM_TIMEOUT_MS)),
    ])

    if (result === null) {
      log.warn({ timeoutMs: LLM_TIMEOUT_MS }, "Transcript LLM cleaning timed out")
      return null
    }

    const cleaned = result.trim().replace(/^"|"$/g, "")
    if (!cleaned) return null
    // The model must not echo our prompt scaffolding.
    if (/^(cleaned transcript|transcript)\s*:/i.test(cleaned)) return null
    return cleaned
  }
}
