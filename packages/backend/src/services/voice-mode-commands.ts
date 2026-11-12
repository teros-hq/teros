/**
 * Voice Mode Commands — spoken mode-change detection (Voice Mode v2, F2b)
 *
 * Spec v1.1.0 REQ-6 (AC-3/AC-4b) + UX doc §2.3 ("Por voz (primaria)"):
 *
 *   "ponte en modo silencio" / "Alice, modo silencio" / "escucha"  → passive
 *   "modo conversación" / "Alice, hablemos" / "hablemos"           → conversation
 *   "Alice, vuelve" / "regresa"                                    → conversation (recovery door from passive)
 *
 * A spoken mode command is a META-ORDER, not a conversation turn: it must be
 * detected BEFORE the invocation gate (in `conversation` everything is a
 * turn, and "ponte en modo silencio" said to nobody in particular must
 * still switch the mode — it is addressed to the SESSION, not the agent),
 * and it never spends an agent turn. The loop acknowledges it with the
 * canonical ack vocabulary (UX §5.1/§5.2: "Vale." / "Dime." / "Aquí estoy.")
 * and the `mode_changed {source:'voice'}` frame — the same authoritative
 * state the UI picker writes to (one voice door, one UI door, one state).
 *
 * Design (same philosophy as the gate, F2a):
 *  - $0/utterance, pure lexical matching, <1 ms, no LLM — mode commands are
 *    a tiny closed vocabulary, not open-ended intent.
 *  - Normalization identical to voice-gate.ts (lowercase, diacritics
 *    stripped — STT drops accents constantly: "atención" arrives as
 *    "atencion", "cállate" as "callate").
 *  - The vocative prefix is OPTIONAL but allowed ("Alice, modo silencio" —
 *    the wake word + a leading imperative is an address; in `passive` the
 *    vocative alone opens the gate, and the command after it must still be
 *    recognized as the meta-order, not forwarded as a turn).
 *  - Asymmetric bias, mirrored: a phrase that merely CONTAINS mode words
 *    ("estábamos en modo silencio y…") must NOT switch the mode — the
 *    command phrases are anchored (imperative + mode noun), so narration
 *    about modes does not match. When in doubt, no switch — the utterance
 *    falls through to the gate as a normal turn.
 *
 * Acks (UX §5.1/§5.2 — the agent confirms with the minimum):
 *   passive      → "Vale."        (luna sweeps, earcon grave — the frontend's ceremony)
 *   conversation → "Dime."        (bloom of light, ring stays lit)
 */

import type { VoiceMode } from '../handlers/voice-loop-frames';

// ============================================================================
// TYPES
// ============================================================================

/** A spoken mode command recognized in an utterance. */
export interface VoiceModeCommand {
  /** The mode the user asked for. */
  mode: VoiceMode;
  /** The canonical ack the agent gives (UX §5.1/§5.2) — spoken via TTS. */
  ack: string;
  /** Matched pattern id — telemetry/debugging (F4 calibration surface). */
  pattern: string;
}

// ============================================================================
// NORMALIZATION (identical to voice-gate.ts — one lexicon surface)
// ============================================================================

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
// PATTERNS (UX §2.3 vocabulary + natural ES/EN variants)
// ============================================================================

/**
 * Passive ("En escucha — solo si me nombras"). UX: "ponte en modo silencio"
 * / "Alice, modo silencio" / "escucha". The canonical spec name is `passive`
 * (naming decision: never `silent` — that is mic mute).
 */
const PASSIVE_PATTERNS: Array<{ id: string; phrases: string[] }> = [
  {
    id: 'modo-silencio',
    phrases: [
      'ponte en modo silencio', 'pon modo silencio', 'modo silencio',
      'ponte en modo escucha', 'pon modo escucha', 'modo escucha',
      'ponte en silencio', 'ponte en escucha', 'entra en modo silencio',
      'cambia a modo silencio', 'cambia al modo silencio',
      // PoC 2026-10-31 (Pablo's own phrasing in the live test)
      'quedate en modo escucha', 'quedate en escucha', 'quedate escuchando',
      'ponte a escuchar', 'ponte en escucha de nuevo', 'vuelve a escucha', 'vuelve a modo escucha',
      // STT accent-dropped + short forms
      'ponte en modo silencio y escucha',
    ],
  },
  {
    id: 'imperative-escucha',
    phrases: [
      'solo escucha', 'solo escuchame', 'escucha y callate',
      'escucha sin hablar', 'escucha sin responder', 'dedicate a escuchar',
      'limitate a escuchar', 'callate y escucha', 'estate callada y escucha',
      'estate en silencio', 'guarda silencio', 'manten silencio',
    ],
  },
  {
    id: 'en-mode-passive', // explicit canonical name (power users / EN calques)
    phrases: ['modo pasivo', 'ponte en modo pasivo', 'pasive mode', 'passive mode'],
  },
];

/**
 * Available ("Disponible — responde si la nombras, no guarda nada"). PoC
 * 2026-10-31 (Pablo, decisions 1-2): the resting mode of the presence.
 * "deja de escuchar" means "stop keeping what you hear", not mic mute.
 */
const AVAILABLE_PATTERNS: Array<{ id: string; phrases: string[] }> = [
  {
    id: 'modo-disponible',
    phrases: [
      'modo disponible', 'ponte en modo disponible', 'pon modo disponible',
      'ponte disponible', 'quedate disponible', 'vuelve a estar disponible',
      'cambia a modo disponible', 'cambia al modo disponible', 'ponte en disponible',
      'ponte de nuevo disponible', 'vuelve a disponible', 'vuelve a modo disponible', 'modo standby',
    ],
  },
  {
    id: 'deja-de-escuchar',
    phrases: ['deja de escuchar', 'ya no escuches', 'no guardes nada', 'deja de guardar'],
  },
  {
    id: 'en-mode-available',
    phrases: ['available mode', 'modo available'],
  },
];

/**
 * Conversation ("Conversación — responde a todo"). UX: "modo conversación" /
 * "Alice, hablemos" / "hablemos". Default mode (decisión de Pablo #4).
 */
const CONVERSATION_PATTERNS: Array<{ id: string; phrases: string[] }> = [
  {
    id: 'modo-conversacion',
    phrases: [
      'modo conversacion', 'ponte en modo conversacion', 'pon modo conversacion',
      'entra en modo conversacion', 'cambia a modo conversacion',
      'cambia al modo conversacion', 'modo charla', 'hablemos de nuevo',
      'volvamos a hablar', 'sigamos hablando', 'podemos hablar',
      // PoC 2026-10-31: the product name is "Conversando" — people say it.
      'modo conversando', 'ponte en modo conversando', 'ponte conversando', 'ponte en conversando',
      'ponte de nuevo conversando', 'ponte de nuevo en modo conversando', 'vuelve a conversando',
      'vuelve a modo conversando', 'cambia a conversando', 'conversando',
    ],
  },
  {
    id: 'hablemos',
    phrases: ['hablemos', 'hablamos', 'vamos a hablar', 'charlemos', 'conversa conmigo'],
  },
  {
    // Recovery door from passive (was attention's — Pablo 2026-10-05: two
    // modes only; "come back" means "talk with me again" → conversation).
    id: 'vuelve',
    phrases: ['vuelve', 'vuelve conmigo', 'regresa', 'regresa conmigo', 'ya estoy aqui contigo'],
  },
  {
    id: 'en-mode-conversation',
    phrases: ['conversation mode', 'modo conversation'],
  },
];



/** Canonical acks per mode (UX §5.1/§5.2 — minimum viable confirmation). */
const MODE_ACKS: Record<VoiceMode, string> = {
  available: 'Vale.',
  passive: 'Vale.',
  conversation: 'Dime.',
};

// ============================================================================
// DETECTION
// ============================================================================

/**
 * Strip an optional leading vocative ("alice modo silencio" ← "Alice, modo
 * silencio") and the safe discourse markers that may precede it, so the
 * command patterns match the command core. Returns the remainder.
 */

/** Words that may wrap an order without changing it ("bueno, ponte en modo escucha, ¿vale?"). */
const LEADING_FILLERS = ['bueno', 'vale', 'oye', 'pues', 'venga', 'a ver', 'por favor', 'porfa', 'entonces', 'ahora', 'y', 'eh'];
const TRAILING_FILLERS = ['vale', 'por favor', 'porfa', 'por fa', 'ok', 'gracias', 'ya', 'eh', 'ahora', 'un rato', 'un momento', 'de nuevo', 'otra vez', 'porfi', 'si'];

function stripFillers(core: string): string {
  let c = core;
  for (;;) {
    let changed = false;
    for (const f of LEADING_FILLERS) {
      if (c === f) return '';
      if (c.startsWith(f + ' ')) { c = c.slice(f.length + 1); changed = true; }
    }
    for (const f of TRAILING_FILLERS) {
      if (c === f) return '';
      if (c.endsWith(' ' + f)) { c = c.slice(0, -(f.length + 1)); changed = true; }
    }
    if (!changed) return c;
  }
}

/**
 * Split the utterance into { addressed, core }: `addressed` is true when the
 * agent's name appears anywhere ("Iria, ponte en modo escucha", "ponte en
 * modo escucha, Iria", or the self-correction "Alice, quédate en… perdón,
 * Iria, quédate en modo escucha"); `core` is the text AFTER the last name
 * (or before it, when the name closes the sentence).
 */
function splitAddress(normalized: string, agentName: string): { addressed: boolean; core: string } {
  const name = normalize(agentName || 'Alice').split(' ')[0] || 'alice';
  const words = normalized.split(' ');
  const last = words.lastIndexOf(name);
  if (last < 0) return { addressed: false, core: normalized };
  const after = words.slice(last + 1).join(' ');
  const before = words.slice(0, last).join(' ');
  return { addressed: true, core: after || before };
}

/**
 * Detect a spoken mode-change command in an utterance (REQ-6, AC-3/AC-4b).
 *
 * Returns the command (mode + ack + pattern) or null when the utterance is
 * not a mode order — the caller lets it fall through to the invocation gate
 * as a normal utterance. Pure function, $0, no LLM.
 *
 * PoC 2026-10-31, round 6 (Pablo's live test with a third person in the room:
 * narration like "…luego hablamos" or "…que se ponga en modo escucha" kept
 * flipping the mode):
 *  - the order must BE the utterance (fillers aside) — never a phrase found
 *    inside a sentence;
 *  - when the session is NOT in conversation (`mode` passive/available), the
 *    order must be addressed (the name somewhere) unless it names the mode
 *    explicitly ("modo escucha", "modo conversando"): bare "hablemos",
 *    "vuelve", "escucha" from an unaddressed room never switch anything.
 */
export function parseVoiceModeCommand(
  transcript: string,
  agentName: string,
  mode: VoiceMode = 'conversation',
): VoiceModeCommand | null {
  const normalized = normalize(transcript);
  if (!normalized) return null;

  const { addressed, core: rawCore } = splitAddress(normalized, agentName);
  const core = stripFillers(rawCore);
  if (!core) return null;
  const mustBeAddressed = mode !== 'conversation' && !addressed;

  const test = (groups: Array<{ id: string; phrases: string[] }>, target: VoiceMode): VoiceModeCommand | null => {
    for (const group of groups) {
      for (const phrase of group.phrases) {
        if (core !== phrase) continue;
        // Unaddressed room in a quiet mode: only an explicit mode noun counts.
        if (mustBeAddressed && !/\bmodo\b/.test(phrase)) return null;
        return { mode: target, ack: MODE_ACKS[target], pattern: group.id };
      }
    }
    return null;
  };

  return (
    test(AVAILABLE_PATTERNS, 'available') ??
    test(PASSIVE_PATTERNS, 'passive') ??
    test(CONVERSATION_PATTERNS, 'conversation')
  );
}
