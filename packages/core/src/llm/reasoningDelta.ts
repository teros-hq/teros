/**
 * Extract a reasoning/thinking delta from an OpenAI-compatible streaming choice
 * `delta`. Providers disagree on the field name: OpenAI-compatible reasoning
 * models (QwQ, DeepSeek R1, GLM/Zhipu) stream `reasoning_content`; OpenRouter
 * and some Ollama builds stream `reasoning`. Returns `''` when neither is a
 * non-empty string.
 *
 * Fed to `callbacks.onThinking` so the turn's stall watchdog counts a silent
 * reasoning block as progress instead of a frozen socket — a reasoning model can
 * emit thinking deltas for a long time before any visible text/tool token, and
 * pre-TER-650 that silence tripped the watchdog. The frontend does not render
 * this channel for OpenAI-compatible providers; it is a timing/heartbeat signal.
 *
 * Kept as a shared helper (not duplicated per adapter) so all five
 * OpenAI-compatible adapters extract reasoning identically — divergence here is
 * exactly the "one path handles it, another doesn't" drift that leaks bugs.
 */
export function extractReasoningDelta(delta: unknown): string {
  if (!delta || typeof delta !== 'object') return '';
  const d = delta as { reasoning_content?: unknown; reasoning?: unknown };
  if (typeof d.reasoning_content === 'string') return d.reasoning_content;
  if (typeof d.reasoning === 'string') return d.reasoning;
  return '';
}
