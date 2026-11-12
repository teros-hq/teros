/**
 * Conversation Evaluator — Anonymizer (PURE module).
 *
 * Task: task_a5725f2e20828c3a (fase 4a)
 * Spec: docs/specs/20261015_conversation-evaluator.md
 * Rule (Pablo, 20-oct): pseudonimize IDENTITIES before the evaluator reads
 * real user conversations. Content is NOT anonymized — only identities.
 *
 * What gets pseudonymized (deterministic, stable across conversations):
 *   - email addresses → `user_<hash>@anon.local`
 *   - internal IDs (channelId, userId, agentId, sessionId, messageId) → `<prefix>_<hash>`
 *   - person names detected in text → `Persona_<hash>` (conservative, see below)
 *   - filesystem paths containing usernames → `/home/<hash>/...`
 *   - tokens / API keys in tool outputs → `token_<hash>`
 *
 * What is NOT touched:
 *   - message content (the evaluator needs full text to judge intents/outcome)
 *   - tool names, callIds, app names (technical metadata, not PII)
 *   - timestamps, durations, costs, token counts
 *
 * Stability contract: the same identity string always produces the same
 * pseudonym, within and across conversations, forever. This is achieved by
 * HMAC-SHA256 with a fixed salt (not a secret — the goal is determinism,
 * not cryptographic protection against brute-force).
 *
 * PURITY CONTRACT: zero I/O. No Mongo, no fs, no network.
 */

import { createHmac } from 'crypto';

// ---------------------------------------------------------------------------
// Salt — fixed, public, deterministic. NOT a secret.
// Changing this salt breaks all existing pseudonyms (new evaluation runs
// would not correlate with prior ones). Treat as immutable.
// ---------------------------------------------------------------------------
const ANONYMIZER_SALT = 'teros-evaluator-anonymizer-v1';

function hmac(data: string): string {
  return createHmac('sha256', ANONYMIZER_SALT).update(data, 'utf8').digest('hex');
}

/** Short hash for display — first 12 hex chars, enough for uniqueness in practice. */
function shortHash(data: string): string {
  return hmac(data).slice(0, 12);
}

// ---------------------------------------------------------------------------
// Email detection & replacement
// ---------------------------------------------------------------------------

/** RFC 5322-ish, pragmatic: catches real emails without false-positiving on paths or URLs. */
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

export function anonymizeEmails(text: string): string {
  return text.replace(EMAIL_RE, (match) => {
    // Skip if already anonymized
    if (match.endsWith('@anon.local')) return match;
    return `user_${shortHash(match.toLowerCase())}@anon.local`;
  });
}

// ---------------------------------------------------------------------------
// Internal ID detection & replacement
// ---------------------------------------------------------------------------

/** Known internal ID prefixes and their anonymized form. */
const ID_PATTERNS: Array<{ pattern: RegExp; prefix: string }> = [
  // channelIds: ch_ followed by 16 hex chars
  { pattern: /\bch_[0-9a-f]{16}\b/g, prefix: 'ch' },
  // userIds: user_ followed by 16 hex chars
  { pattern: /\buser_[0-9a-f]{16}\b/g, prefix: 'user' },
  // agentIds: agent_ followed by 16 hex chars
  { pattern: /\bagent_[0-9a-f]{16}\b/g, prefix: 'agent' },
  // sessionIds: sess_ followed by 16 hex chars
  { pattern: /\bsess_[0-9a-f]{16}\b/g, prefix: 'sess' },
  // messageIds: msg_ followed by 16 hex chars
  { pattern: /\bmsg_[0-9a-f]{16}\b/g, prefix: 'msg' },
  // evaluationIds: ev_ followed by 12+ alphanumeric
  { pattern: /\bev_[0-9a-z]{12,}\b/g, prefix: 'ev' },
  // callIds: call_ followed by digits
  { pattern: /\bcall_\d+\b/g, prefix: 'call' },
  // Generic ObjectId-like: 24 hex chars (Mongo _id)
  { pattern: /\b[0-9a-f]{24}\b/g, prefix: 'oid' },
];

export function anonymizeIds(text: string): string {
  let result = text;
  for (const { pattern, prefix } of ID_PATTERNS) {
    result = result.replace(pattern, (match) => {
      // Skip if already anonymized (contains a hash suffix)
      if (match.includes('_') && /_[0-9a-f]{12}$/.test(match)) return match;
      return `${prefix}_${shortHash(match)}`;
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Filesystem path usernames
// ---------------------------------------------------------------------------

/** Paths like /home/username/... or /Users/username/... → /home/<hash>/... */
const PATH_USER_RE = /(\/(?:home|Users)\/)([^/\s]+)(\/|\s|$)/g;

export function anonymizePaths(text: string): string {
  return text.replace(PATH_USER_RE, (_match, prefix: string, username: string, suffix: string) => {
    // Skip well-known system users
    if (['root', 'node', 'www-data', 'nginx', 'postgres', 'docker'].includes(username)) {
      return `${prefix}${username}${suffix}`;
    }
    return `${prefix}${shortHash(username)}${suffix}`;
  });
}

// ---------------------------------------------------------------------------
// Token / API key detection in tool outputs
// ---------------------------------------------------------------------------

/**
 * Patterns that look like secrets. Conservative: only match things that are
 * almost certainly tokens/keys, not random hex strings (those are handled by
 * the ObjectId pattern above if they're 24 chars).
 */
const TOKEN_PATTERNS: RegExp[] = [
  // Bearer tokens
  /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi,
  // API keys: sk-..., pk-..., key-..., etc.
  /\b(?:sk|pk|key|api|token|secret|password|auth)[-_][A-Za-z0-9._~+/=-]{16,}\b/gi,
  // JWTs (three base64url segments)
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  // AWS-style keys
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Generic long hex strings that are NOT ObjectIds (32, 40, 64 chars)
  /\b[0-9a-f]{32}\b/g,
  /\b[0-9a-f]{40}\b/g,
  /\b[0-9a-f]{64}\b/g,
];

export function anonymizeTokens(text: string): string {
  let result = text;
  for (const pattern of TOKEN_PATTERNS) {
    result = result.replace(pattern, (match) => `token_${shortHash(match)}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Person name detection (conservative)
// ---------------------------------------------------------------------------

/**
 * Detect person names in text. This is intentionally conservative:
 * - Only capitalized words that appear in a small set of known first names
 *   OR are preceded by "de", "por", "para", "con", "from", "to", "by", "with"
 *   OR are followed by a capitalized word (First Last pattern)
 * - Never touches lowercase words, URLs, file paths, or code identifiers
 * - The goal is to catch "Pablo dijo..." or "hablé con María" without
 *   destroying the readability of the transcript.
 *
 * Known limitation: this will miss some names and may false-positive on
 * capitalized common nouns at sentence start. The evaluator is instructed
 * to treat `Persona_xxx` as an anonymized identity, not as a literal name.
 */

/** Small set of common Spanish/English first names to catch the most frequent cases. */
const KNOWN_NAMES = new Set([
  'pablo', 'maría', 'maria', 'juan', 'ana', 'carlos', 'laura', 'diego', 'sofía', 'sofia',
  'martín', 'martin', 'lucía', 'lucia', 'fernando', 'carmen', 'javier', 'elena', 'miguel',
  'isabel', 'david', 'raquel', 'sergio', 'patricia', 'alejandro', 'cristina', 'daniel',
  'paula', 'adrián', 'adrian', 'beatriz', 'rubén', 'ruben', 'natalia', 'álvaro', 'alvaro',
  'irene', 'víctor', 'victor', 'sara', 'andrea', 'jorge', 'claudia', 'ángel', 'angel',
  'marina', 'raúl', 'raul', 'noelia', 'óscar', 'oscar', 'alba', 'hugo', 'julia',
  'john', 'jane', 'michael', 'sarah', 'emma', 'james', 'olivia', 'robert',
  'william', 'sophia', 'richard', 'joseph', 'thomas', 'charles', 'matthew',
]);

/** Prepositions/articles that often precede a person name in Spanish/English. */
const NAME_PRECEDERS = /\b(?:de|por|para|con|from|to|by|with|hacia|sobre|about)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)\b/g;

/** First Last pattern: two consecutive capitalized words. */
const FULL_NAME_RE = /\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+|Persona_[0-9a-f]{12})\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)\b/g;

export function anonymizeNames(text: string): string {
  let result = text;

  // Pass 1: known names — only replace when capitalized (as names are).
  // Case-insensitive matching for hash stability, but lowercase occurrences are left alone.
  for (const name of KNOWN_NAMES) {
    const re = new RegExp(`\\b${name}\\b`, 'gi');
    result = result.replace(re, (match) => {
      // Only replace if the original text has it capitalized (name-like)
      if (match[0] !== match[0].toUpperCase()) return match;
      const canonical = name.toLowerCase();
      return `Persona_${shortHash(canonical)}`;
    });
  }

  // Pass 2: preposition + capitalized word (likely a name)
  result = result.replace(NAME_PRECEDERS, (match, word: string) => {
    const lower = word.toLowerCase();
    if (KNOWN_NAMES.has(lower)) return match; // already handled
    // Don't anonymize common capitalized words that are not names
    if (['El', 'La', 'Los', 'Las', 'Un', 'Una', 'The', 'A', 'An', 'This', 'That'].includes(word)) {
      return match;
    }
    return match.replace(word, `Persona_${shortHash(lower)}`);
  });

  // Pass 3: First Last pattern (conservative: only if first word is a known name
  // OR already anonymized as Persona_xxx from pass 1)
  result = result.replace(FULL_NAME_RE, (match, first: string, last: string) => {
    const firstLower = first.toLowerCase();
    if (KNOWN_NAMES.has(firstLower) || first.startsWith('Persona_')) {
      return `Persona_${shortHash(firstLower)} Persona_${shortHash(last.toLowerCase())}`;
    }
    return match;
  });

  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AnonymizeOptions {
  /** Anonymize email addresses (default: true) */
  emails?: boolean;
  /** Anonymize internal IDs (default: true) */
  ids?: boolean;
  /** Anonymize filesystem path usernames (default: true) */
  paths?: boolean;
  /** Anonymize tokens/API keys in text (default: true) */
  tokens?: boolean;
  /** Anonymize person names (default: true) */
  names?: boolean;
}

const DEFAULT_OPTIONS: Required<AnonymizeOptions> = {
  emails: true,
  ids: true,
  paths: true,
  tokens: true,
  names: true,
};

/**
 * Anonymize a single text string. Applies all enabled detectors in order:
 * tokens → emails → IDs → paths → names.
 * Order matters: tokens first (they may contain emails/IDs), names last
 * (they may be inside paths or emails already handled).
 */
export function anonymizeText(text: string, options: AnonymizeOptions = {}): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let result = text;
  if (opts.tokens) result = anonymizeTokens(result);
  if (opts.emails) result = anonymizeEmails(result);
  if (opts.ids) result = anonymizeIds(result);
  if (opts.paths) result = anonymizePaths(result);
  if (opts.names) result = anonymizeNames(result);
  return result;
}

/**
 * Anonymize a WindowMessage array (the L2 pipeline input).
 * Only text parts and tool inputs/outputs are touched. callIds, tool names,
 * status, timestamps are left intact (technical metadata, not PII).
 */
export function anonymizeWindowMessages<T extends { parts: Array<{ kind: string; text?: string; input?: unknown; output?: string; error?: string }> }>(
  messages: T[],
  options: AnonymizeOptions = {},
): T[] {
  return messages.map((msg) => ({
    ...msg,
    parts: msg.parts.map((part) => {
      if (part.kind === 'text' && part.text) {
        return { ...part, text: anonymizeText(part.text, options) };
      }
      if (part.kind === 'tool') {
        const p = part as { kind: 'tool'; input?: unknown; output?: string; error?: string };
        return {
          ...p,
          input: p.input !== undefined ? anonymizeValue(p.input, options) : undefined,
          output: p.output !== undefined ? anonymizeText(p.output, options) : undefined,
          error: p.error !== undefined ? anonymizeText(p.error, options) : undefined,
        };
      }
      return part;
    }),
  }));
}

/**
 * Anonymize an EvalMessage array (the L1 pipeline input).
 * Only text and tool inputs are touched. callIds, tool names, status,
 * timestamps are left intact.
 */
export function anonymizeEvalMessages<T extends { text: string; toolCalls: Array<{ input: unknown; inputKey: string }> }>(
  messages: T[],
  options: AnonymizeOptions = {},
): T[] {
  return messages.map((msg) => ({
    ...msg,
    text: anonymizeText(msg.text, options),
    toolCalls: msg.toolCalls.map((tc) => {
      const anonInput = anonymizeValue(tc.input, options);
      return {
        ...tc,
        input: anonInput,
        inputKey: stableStringifyForAnonymizer(anonInput),
      };
    }),
  }));
}

/** Recursively anonymize all string values in an object/array. */
function anonymizeValue(value: unknown, options: AnonymizeOptions): unknown {
  if (typeof value === 'string') {
    return anonymizeText(value, options);
  }
  if (Array.isArray(value)) {
    return value.map((v) => anonymizeValue(v, options));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = anonymizeValue(v, options);
    }
    return result;
  }
  return value;
}

/** Local stableStringify to avoid circular dependency with l1-extractor. */
function stableStringifyForAnonymizer(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(stableStringifyForAnonymizer).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringifyForAnonymizer((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return String(value);
}

/**
 * Anonymize a channelId for use in evaluation records.
 * The channelId is the primary key of the conversation — it must be
 * pseudonymized so the evaluator cannot look up the real conversation.
 */
export function anonymizeChannelId(channelId: string): string {
  return `ch_${shortHash(channelId)}`;
}

/**
 * Anonymize a userId for use in evaluation records.
 */
export function anonymizeUserId(userId: string): string {
  return `user_${shortHash(userId)}`;
}

/**
 * Anonymize an agentId for use in evaluation records.
 */
export function anonymizeAgentId(agentId: string): string {
  return `agent_${shortHash(agentId)}`;
}
