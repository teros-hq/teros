/**
 * Voice Invocation Gate — 2-layer addressee detection (Voice Mode v2, F2a)
 *
 * Spec v1.1.0 REQ-7 (§diagrama del gate): decide whether an utterance is
 * addressed to the agent BEFORE spending the conversation LLM —
 *
 *   Layer 1 — Vocative        "Alice, …" — ALL modes, regex/patterns, $0.
 *                              The guaranteed emergency ladder (máxima
 *                              fiabilidad, coste mínimo).
 *   Layer 3 — Dialogue context  `conversation`: everything is a turn; the
 *                              LLM itself decides response-worthiness through
 *                              the conversation context (coste cero). The
 *                              system-prompt mechanism is the voice-turn
 *                              context note (buildVoiceTurnContext) that
 *                              rides the first turn after connect/mode change.
 *
 * (Layer 2 — the attention-only target-of-speech classifier — was removed
 * with the `attention` mode itself, Pablo 2026-10-05: two modes only,
 * conversation and passive. In passive the vocative is the only door, so
 * there is nothing for a classifier to decide.)
 *
 * ASYMMETRIC BIAS (spec REQ-7, UC §3.2 — "cuando dude, calla"): a false
 * positive (answering when not addressed) is the SEVERE failure — it breaks
 * trust and silences the user in front of others; a false negative is
 * recovered with one word ("Alice, …"). Consequences, by construction:
 *   - score starts at 0 (silence is the default, not the exception);
 *   - a single strong lexical signal (0.4) NEVER opens — it takes two strong
 *     signals, or one strong + dialogue state;
 *   - negative evidence CAPS the score (thinking-out-loud ≤0.4,
 *     third-party ≤0.35) instead of merely subtracting;
 *   - a third-person mention of the agent hard-zeros the score.
 *
 * REQ-7 MUST NOT ("le dije a Alice que…" no dispara respuesta en ningún modo"):
 * a mention of the agent's name that is not a vocative never activates the
 * gate in ANY mode — including `conversation` (evaluateInvocationGate checks
 * it before the conversation layer opens).
 */

import type { VoiceMode } from '../handlers/voice-loop-frames';

// ============================================================================
// TYPES
// ============================================================================

/** Which layer opened the gate ('vocative' = layer 1, 'target' = layer 2, 'context' = layer 3). */
export type GateLayer = 'vocative' | 'target' | 'context';

/**
 * Dialogue state for the layer-2 classifier (research §3.3 signal 3:
 * "¿Alice acaba de hablar? → más probable que la respuesta siguiente vaya a
 * ella"). Owned by the voice loop connection.
 */
export interface GateDialogueState {
  /**
   * The agent's turn completed (TTS drained / turn done) and no overheard
   * utterance has intervened — a reply is more likely directed at the agent.
   */
  agentJustSpoke: boolean;
  /**
   * Dialogue window (Pablo, PoC 2026-10-31): in `passive`, once the agent has
   * answered an invocation, the user can keep talking to her WITHOUT the name
   * for a few seconds (epoch ms until which the window is open). Re-armed
   * each time the agent's playback ends; cleared by any mode change
   * (including the agent's own set_mode('passive') — "vale, gracias" closes it).
   */
  dialogueWindowUntil?: number | null;
  /**
   * This utterance interrupted the agent's speech (barge-in) — interrupting
   * someone is inherently addressing them. One-shot: consumed by the
   * evaluation that reads it.
   */
  interruptedAgentSpeech: boolean;
}

/** The gate's verdict for one utterance — telemetry-ready (F2a/UC-12). */
export interface GateDecision {
  /** Did the utterance become an agent turn? (false → persists as overheard) */
  activated: boolean;
  /** The layer that opened the gate; null when not activated. */
  layer: GateLayer | null;
  /** 1 for vocative/context; the classifier score for 'target'; 0 when not activated. */
  score: number;
  /**
   * The layer-2 classifier's score when it evaluated this utterance; null when
   * the classifier was not consulted (vocative / about-agent / conversation /
   * passive). The telemetry calibration mean aggregates ONLY these —
   * zero-scored non-classifier decisions must not pollute it (F4).
   */
  classifierScore: number | null;
  /** Matched signals (lexicon hits + dialogue state) — the calibration surface for F4. */
  signals: string[];
  /** Human-readable explanation (structured log / debugging). */
  reason: string;
}

// ============================================================================
// NORMALIZATION
// ============================================================================

/**
 * Lexicon matching surface: lowercase, diacritics stripped (STT drops accents
 * constantly — "qué te parece" arrives as "que te parece"), punctuation to
 * spaces, whitespace collapsed.
 */
function normalize(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================================================
// LAYER 1 — VOCATIVE (REQ-7: all modes, regex/patterns, $0)
// ============================================================================

/**
 * Common STT confusions for known wake words. Spanish STT frequently returns
 * "Alicia"/"Alise" for a spoken "Alice"; excluding them would break the
 * guaranteed ladder exactly when it is needed (the user SAID "Alice", the STT
 * wrote "Alicia" → no response). Tradeoff: a third party actually named
 * "Alicia" can produce a false vocative — rarer in a 1:1 session, recoverable
 * via barge-in, and documented here. Extend with real traffic (F4 calibration).
 */
const STT_WAKE_CONFUSIONS: Record<string, string[]> = {
  alice: ['alise', 'alicia', 'alis', 'alyce'],
};

/** Wake word variants for an agent name (normalized first name). */
function wakeVariants(agentName: string): string[] {
  const name = normalize(agentName || 'Alice').split(' ')[0] || 'alice';
  return Array.from(new Set([name, ...(STT_WAKE_CONFUSIONS[name] ?? [])]));
}

/**
 * Discourse markers that may safely precede a vocative — "oye, Alice…",
 * "bueno Alice…", "hey Alice…". Allow-list (conservative): anything else
 * before the name reads as a mention, not an address.
 */
const PRE_VOCATIVE_MARKERS = new Set([
  'oye', 'oiga', 'bueno', 'vale', 'mira', 'perdona', 'perdon', 'disculpa', 'hola',
  'eh', 'e', 'mm', 'mmm', 'pues', 'venga', 'anda', 'vamos', 'este', 'digamos',
  'escucha', 'no', 'si',
  'hey', 'hi', 'hello', 'ok', 'okay', 'well', 'so', 'um', 'uh', 'please', 'and',
]);

/** Multi-word phrases that may safely precede a vocative ("a ver, Alice…"). */
const PRE_VOCATIVE_PHRASES = new Set(['a ver', 'no espera', 'espera espera', 'a ver a ver']);

/**
 * Words that make a nearby name a MENTION, not an address — prepositions,
 * determiners, possessives, relational nouns and narration verbs
 * ("le dije a Alice…", "para Alice…", "mi amiga Alice…").
 */
const MENTION_PRECEDERS = new Set([
  'a', 'al', 'de', 'del', 'para', 'por', 'sobre', 'con', 'sin', 'segun', 'tras',
  'entre', 'como', 'que', 'donde', 'tal',
  'mi', 'mis', 'su', 'sus', 'nuestro', 'nuestra', 'vuestro', 'vuestra',
  'el', 'la', 'los', 'las', 'un', 'una', 'este', 'esta', 'ese', 'esa',
  'amiga', 'amigo', 'colega', 'jefa', 'jefe', 'hermana', 'hermano', 'madre',
  'padre', 'hija', 'hijo', 'esposa', 'marido', 'novia', 'novio', 'vecina',
  'vecino', 'asistente', 'secretaria', 'secretario', 'doctora', 'doctor',
  'profesora', 'profesor', 'companera', 'companero', 'socia', 'socio',
  'dije', 'digo', 'dijimos', 'pregunte', 'pregunto', 'comente', 'escribi',
  'hable', 'mande', 'envie', 'conte', 'avise', 'llame', 'vi', 'encontre',
  'of', 'to', 'for', 'with', 'about', 'from', 'the', 'my', 'his', 'her', 'our',
  'their', 'this', 'that', 'friend', 'boss', 'sister', 'brother', 'wife',
  'husband', 'assistant', 'colleague', 'doctor', 'teacher', 'told', 'asked', 'said',
]);

/**
 * Third-person markers right AFTER a leading vocative-position name — the
 * agent is the SUBJECT ("Alice dice que…", "Alice está…") → talking ABOUT
 * her, not TO her. "es que" is the exception ("Alice, es que no entiendo" —
 * a discourse opener, still an address).
 */
const THIRD_PERSON_AFTER = [
  'is', 'was', 'has', 'had', 'will', 'should', 'would', 'says', 'said', 'told',
  'es', 'esta', 'era', 'fue', 'ha', 'han', 'dice', 'dijo', 'va', 'puede',
  'podia', 'estaba', 'sera', 'parece', 'quiere', 'quiso', 'sabe', 'sabia',
  'hizo', 'hace', 'hara', 'puede',
];

/** Is the (possibly empty) segment before a vocative-position name safe? */
function isSafePreVocative(preceding: string): boolean {
  if (!preceding) return true;
  if (PRE_VOCATIVE_PHRASES.has(preceding)) return true;
  return preceding.split(' ').every((w) => PRE_VOCATIVE_MARKERS.has(w));
}

/** Does the transcript mention the agent's name (or an STT variant) anywhere? */
function mentionsAgent(transcript: string, agentName: string): boolean {
  const variants = wakeVariants(agentName);
  return normalize(transcript).split(' ').some((w) => variants.includes(w));
}

/**
 * Layer 1 — does the utterance directly address the agent by name?
 *
 * Vocative positions recognized (spec: "al inicio (o cerca) de la frase"):
 *  - bare hail: "Alice" / "¿Alice?" — calling her;
 *  - leading: the name within the first 3 words, preceded only by safe
 *    discourse markers ("oye, Alice, ¿…?", "bueno Alice dime");
 *  - trailing: the name as the LAST word with a safe word before it
 *    ("¿qué te parece, Alice?") — a preposition/determiner/relational noun
 *    before it ("se lo dije a Alice", "mi amiga Alice") keeps it a mention.
 *
 * Third-person mentions ("le dije a Alice que…", "Alice dice que…") do NOT
 * match — REQ-7 MUST NOT.
 */
export function isVocativeAddress(transcript: string, agentName: string): boolean {
  const raw = (transcript || '').trim();
  if (!raw) return false;
  const text = normalize(raw);
  if (!text) return false;
  const words = text.split(' ');
  const variants = wakeVariants(agentName);

  // (a) Bare hail — "Alice", "¿Alice?".
  if (words.length === 1 && variants.includes(words[0])) return true;

  // (b) Leading vocative — name within the first 3 words.
  const lead = Math.min(3, words.length);
  for (let i = 0; i < lead; i++) {
    if (!variants.includes(words[i])) continue;
    const preceding = words.slice(0, i).join(' ');
    if (!isSafePreVocative(preceding)) return false; // "le dije a Alice…" → mention
    const after = words.slice(i + 1).join(' ');
    if (!after) return true; // "oye Alice" — hail with markers
    if (after === 'es que' || after.startsWith('es que ')) return true; // "Alice, es que no entiendo"
    const thirdPerson = THIRD_PERSON_AFTER.find((m) => after === m || after.startsWith(m + ' '));
    if (thirdPerson) return false; // "Alice dice que…" / "Alice está…" → about her
    return true;
  }

  // (c) Trailing vocative — "¿qué te parece, Alice?".
  if (words.length >= 2 && variants.includes(words[words.length - 1])) {
    const before = words[words.length - 2];
    if (!MENTION_PRECEDERS.has(before)) return true;
  }

  return false;
}


// ============================================================================
// LAYER 3 — DIALOGUE CONTEXT (REQ-7: conversation) — the system-prompt door
// ============================================================================

/**
 * Layer-3 voice-turn context note: rides the FIRST agent turn after connect
 * or a mode change (appended to the turn text — session_messages/LLM view,
 * never the visible channel transcript, same mechanism as the barge-in
 * context). This is how the LLM knows it is in a voice session and can
 * decide response-worthiness with the conversation context — in
 * `conversation` everything is a turn, and the note instructs minimal
 * responses for filler/noise.
 */
/**
 * A closure of the exchange ("vale", "gracias", "ya está"…) said while the
 * dialogue window is open (PoC 2026-10-31, Pablo: "si le digo vale, gracias
 * → se queda en silencio y no habla"). Detected in CODE, not left to the
 * model: the window closes at once and no turn is spent.
 */
const CLOSURE_PHRASES = new Set([
  'vale', 'ok', 'okay', 'oka', 'gracias', 'muchas gracias', 'vale gracias', 'ok gracias',
  'ya esta', 'ya', 'perfecto', 'genial', 'listo', 'nada mas', 'eso es todo', 'estupendo',
  'vale perfecto', 'vale ya esta', 'muy bien', 'de acuerdo', 'entendido', 'thanks', 'thank you',
]);
export function isClosurePhrase(transcript: string): boolean {
  const n = normalize(transcript);
  return n.length > 0 && CLOSURE_PHRASES.has(n);
}

export function buildVoiceTurnContext(mode: VoiceMode): string {
  switch (mode) {
    case 'conversation':
      return '[Sesión de voz activa, modo conversación. El usuario te habla por voz y tu respuesta se reproducirá hablada: responde breve y natural, sin markdown ni listas largas. Todo lo que oyes es un turno del diálogo: con el contexto de la conversación decide si la frase requiere respuesta; si es muletilla, ruido o algo que no va contigo, responde lo mínimo indispensable. Nunca cambies de modo con set_mode salvo que el usuario te lo pida de forma explícita en esta misma frase.]';
    case 'passive':
      return '[Sesión de voz activa, modo escucha. El usuario te ha nombrado: responde solo a esto, breve y natural, hablada. En modo escucha el usuario quiere que digas lo mínimo posible. Tras tu respuesta tiene unos segundos para seguir hablándote sin nombrarte. Si cierra el intercambio ("vale", "gracias", "ya está", "nada más"), responde con una sola palabra como mucho y llama a la tool set_mode con mode "passive" para volver al silencio de escucha de inmediato.]';
    case 'available':
      return '[Sesión de voz activa, modo disponible. El usuario te ha nombrado: responde solo a esto, breve y natural, hablada. En este modo no guardas nada de lo que oyes alrededor: solo lo que te dicen a ti. Di lo mínimo posible. Tras tu respuesta el usuario tiene unos segundos para seguir hablándote sin nombrarte. Si cierra el intercambio ("vale", "gracias", "ya está"), responde con una sola palabra como mucho y llama a la tool set_mode con mode "available" para volver al silencio de inmediato.]';
  }
}

// ============================================================================
// GATE ORCHESTRATION (spec order: layer 1 → 2 → 3, by mode)
// ============================================================================

/**
 * Evaluate the 3-layer invocation gate for one utterance.
 *
 * Order (spec §diagrama del gate):
 *  1. Layer 1 vocative — ALL modes (cheapest, most reliable; the ladder).
 *  2. Third-person mention of the agent → NEVER activates, any mode
 *     (REQ-7 MUST NOT — checked before the conversation layer opens).
 *  3. Mode-specific: `conversation` → layer 3 (everything is a turn);
 *     `passive` → the vocative is the only door (spec §edge cases).
 */
export function evaluateInvocationGate(
  transcript: string,
  mode: VoiceMode,
  agentName: string,
  dialogue: GateDialogueState,
  now: number = Date.now(),
): GateDecision {
  // Layer 1 — vocative (ALL modes).
  if (isVocativeAddress(transcript, agentName)) {
    return {
      activated: true,
      layer: 'vocative',
      score: 1,
      classifierScore: null,
      signals: ['vocative'],
      reason: 'vocativo: nombre en posición de invocación (capa 1)',
    };
  }

  // REQ-7 MUST NOT: a mention of the agent that is not a vocative never
  // triggers a response — in ANY mode (including conversation).
  if (mentionsAgent(transcript, agentName)) {
    return {
      activated: false,
      layer: null,
      score: 0,
      classifierScore: null,
      signals: ['about-agent'],
      reason: 'mención en 3ª persona (sobre la agente) — no dispara en ningún modo (REQ-7)',
    };
  }

  if (mode === 'conversation') {
    // Layer 3 — dialogue context: everything is a turn; the LLM decides
    // response-worthiness through the conversation context (coste cero).
    return {
      activated: true,
      layer: 'context',
      score: 1,
      classifierScore: null,
      signals: ['conversation'],
      reason: 'modo conversación: todo es turno (capa 3)',
    };
  }

  // passive / available + open dialogue window: the agent just answered an
  // invocation and the user is still talking to her — no name needed for a
  // few seconds.
  if (dialogue.dialogueWindowUntil != null && now <= dialogue.dialogueWindowUntil) {
    return {
      activated: true,
      layer: 'context',
      score: 1,
      classifierScore: null,
      signals: [mode, 'dialogue-window'],
      reason: `modo ${mode === 'available' ? 'disponible' : 'escucha'}: ventana de diálogo abierta tras la última respuesta (sin nombre)`,
    };
  }

  // passive / available: the vocative is the ONLY door (spec §edge cases).
  return {
    activated: false,
    layer: null,
    score: 0,
    classifierScore: null,
    signals: [mode],
    reason: `modo ${mode === 'available' ? 'disponible' : 'escucha'}: solo el vocativo abre (capa 1)`,
  };
}
