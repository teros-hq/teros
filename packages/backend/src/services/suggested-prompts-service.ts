/**
 * Suggested Prompts Service
 *
 * Generates 2-3 contextual follow-up prompts for a conversation, shown in the
 * composer area (replacing the "{agent} can use" tools row) once a channel has
 * at least one message. Regenerated after every agent response so suggestions
 * are always fresh relative to the last turn.
 *
 * Uses the cheap internal LLM (InternalLLMService → teros-glm-5p3-flash,
 * credential-free Teros provider) — never the conversation's main model.
 *
 * Failure policy: any error → return null. The caller shows nothing; the chat
 * is never blocked by suggestion generation.
 */

import { createLogger } from "../lib/logger"
import type { ChannelManager } from "./channel-manager"
import type { InternalLLMService } from "./internal-llm-service"

const log = createLogger("SuggestedPrompts")

/** Max characters of each message's text fed to the generator. */
const PER_MESSAGE_CHARS = 1200
/** Max characters of the whole context block. */
const MAX_CONTEXT_CHARS = 9000
/** Hard cap on a single suggestion length (defensive; the prompt asks for short). */
const MAX_PROMPT_CHARS = 120

export class SuggestedPromptsService {
  constructor(
    private channelManager: ChannelManager,
    private internalLLM: InternalLLMService,
  ) {}

  /**
   * Generate 2-3 follow-up prompts for the latest turn of a channel.
   * Returns null when generation fails or the output is unusable — the
   * caller then leaves whatever was cached before (or nothing).
   */
  async generateForChannel(channelId: string): Promise<string[] | null> {
    try {
      // Latest messages, oldest → newest. The last assistant answer matters
      // most; a handful of previous turns give it continuity.
      const { messages } = await this.channelManager.getMessages(channelId, 10)
      if (messages.length === 0) return null

      const messageContext = messages
        .filter((m: any) => m.content?.type === "text" && m.content?.text)
        .map((m: any) => {
          const text = String(m.content.text).slice(0, PER_MESSAGE_CHARS)
          return `${m.role}: ${text}`
        })
        .join("\n")
        .slice(0, MAX_CONTEXT_CHARS)

      if (!messageContext.trim()) return null

      const prompt = `You write suggested follow-up messages for a chat between a user and their AI assistant.

Based on the conversation below (the LAST assistant message is the most recent turn), write 2 or 3 short messages the USER might naturally send next.

STRICT RULES:
- Write as the USER, first person ("Revisa...", "I want...", depending on language)
- Same language as the conversation (if the conversation is in Spanish, write in Spanish)
- Short phrases (max ~12 words each), no quotes, no numbering, no explanations
- Concrete and contextual to what was just discussed — never generic ("thanks", "ok", "continue")
- Different intents per suggestion (e.g. one check-status, one new request, one detail/refinement)

Conversation:
${messageContext}

Respond with ONLY a JSON object, no markdown fences:
{"prompts": ["...", "...", "..."]}`

      const raw = await this.internalLLM.generateStructured(prompt, 800)
      if (!raw) return null

      const prompts = this.parsePrompts(raw)
      if (!prompts) return null

      log.info({ channelId, count: prompts.length }, "Suggested prompts generated")
      return prompts
    } catch (error) {
      log.error({ err: error, channelId }, "Error generating suggested prompts")
      return null
    }
  }

  /**
   * Parse the model output into a clean string[]. Tolerates markdown fences
   * and stray text around the JSON. Returns null when nothing usable is found.
   */
  parsePrompts(raw: string): string[] | null {
    let text = raw.trim()
    // Strip markdown fences if present
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fence) text = fence[1].trim()

    // Find the JSON object (the model may add prose around it)
    const start = text.indexOf("{")
    const end = text.lastIndexOf("}")
    if (start === -1 || end === -1 || end <= start) return null

    let parsed: unknown
    try {
      parsed = JSON.parse(text.slice(start, end + 1))
    } catch {
      return null
    }

    const list = Array.isArray((parsed as any)?.prompts)
      ? (parsed as any).prompts
      : Array.isArray(parsed)
        ? (parsed as any)
        : null
    if (!list) return null

    const cleaned = list
      .filter((p: unknown): p is string => typeof p === "string")
      .map((p: string) => p.trim().replace(/^["'„"«]|["'""»]$/g, "").trim())
      .filter((p: string) => p.length > 0 && p.length <= MAX_PROMPT_CHARS)
      // Dedupe (case-insensitive)
      .filter((p: string, i: number, arr: string[]) =>
        arr.findIndex((q: string) => q.toLowerCase() === p.toLowerCase()) === i
      )
      .slice(0, 3)

    return cleaned.length >= 2 ? cleaned : null
  }
}
