/**
 * Description tense helper (Renderer UX Guide v2 §2).
 *
 * Produces the right verb tense for the Tool Call Card description based on
 * the current status:
 *
 *   pending             → future ("Will list events")
 *   running             → present ("Listing events…")
 *   completed           → past ("Listed 3 events")
 *   failed              → "Failed to <future-bare>" ("Failed to list events")
 *   pending_permission  → "Wants to <future-bare>" ("Wants to list events")
 *
 * Renderers pass three forms via the `forms` arg. The future form should be
 * a bare verb phrase ("list events", "send email") so we can prefix with
 * "Will / Failed to / Wants to" without breaking grammar.
 *
 * Keeps tense logic out of every individual renderer.
 */

import type { McaStatusType } from './colors';
import { MCA_STRINGS } from './strings';

export interface TenseForms {
  /** bare verb phrase: "list events", "send email", "delete file" */
  future: string;
  /** present continuous: "Listing events", "Sending email" — no ellipsis */
  present: string;
  /** past simple: "Listed 3 events", "Sent email" */
  past: string;
}

export function tenseByStatus(status: McaStatusType, forms: TenseForms): string {
  switch (status) {
    case 'pending':
      return capitalize(`${MCA_STRINGS.tense.will} ${forms.future}`);
    case 'running':
      return `${forms.present}…`;
    case 'completed':
      return forms.past;
    case 'failed':
      return capitalize(`${MCA_STRINGS.tense.failedTo} ${forms.future}`);
    case 'pending_permission':
      return capitalize(`${MCA_STRINGS.tense.wantsTo} ${forms.future}`);
    // Inline user form (request-user-input). The FormWidget renders its own
    // header, so this case exists for exhaustiveness — any generic card that
    // somehow sees the status still reads naturally.
    case 'pending_user_input':
      return capitalize(`${MCA_STRINGS.tense.wantsTo} ${forms.future}`);
  }
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Infer tense forms from a verb-first imperative label like "List files" or
 * "Send email". Returns `{ future, present, past }` that `tenseByStatus` can
 * consume. The first word is treated as the verb; the rest stays untouched.
 *
 * Handles a small set of irregular verbs explicitly (get/got, send/sent,
 * run/ran, set/set, write/wrote, read/read, find/found, make/made). Regular
 * verbs use English suffix rules: drop trailing "e" then add "ing"; add "ed"
 * for past (also dropping the trailing "e" first).
 *
 * Falls back to the original label for both `present` and `past` when no
 * verb is detected. The shell still gets a sensible string in every case.
 */
const IRREGULAR_VERBS: Record<string, { present: string; past: string }> = {
  get: { present: 'getting', past: 'got' },
  send: { present: 'sending', past: 'sent' },
  run: { present: 'running', past: 'ran' },
  set: { present: 'setting', past: 'set' },
  write: { present: 'writing', past: 'wrote' },
  read: { present: 'reading', past: 'read' },
  find: { present: 'finding', past: 'found' },
  make: { present: 'making', past: 'made' },
  cut: { present: 'cutting', past: 'cut' },
  put: { present: 'putting', past: 'put' },
  give: { present: 'giving', past: 'gave' },
  take: { present: 'taking', past: 'took' },
  build: { present: 'building', past: 'built' },
  pay: { present: 'paying', past: 'paid' },
  do: { present: 'doing', past: 'done' },
  hold: { present: 'holding', past: 'held' },
};

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);

/**
 * Verbs that double their final consonant before `-ing`/`-ed`. English
 * doubles when the final syllable is stressed and ends in CVC
 * (consonant-vowel-consonant). Stress isn't recoverable from spelling
 * alone — `cover` and `submit` both end in CVC but only `submit` doubles,
 * because the stress falls on `-mit`. To avoid false positives like
 * "coverred"/"opened" → "opped", we use an explicit allow-list of verbs
 * that appear (or could plausibly appear) as imperatives in MCA tool
 * labels.
 *
 * Add a verb here when:
 *   - It's monosyllabic ending in CVC with the final consonant not in
 *     `w`/`x`/`y`/`h` (stop, plan, drop, log, tag, …), OR
 *   - It's a multisyllable with stress on the final syllable (submit,
 *     cancel, permit, commit, prefer, refer, occur, equip, …).
 *
 * If a verb is missing from this set the regular `-ing`/`-ed` suffix is
 * applied — at worst that produces a slightly off form like "submiting"
 * rather than a wrong form like "coverring".
 */
const DOUBLING_VERBS = new Set([
  // monosyllables (CVC)
  'stop', 'plan', 'drop', 'log', 'tag', 'map', 'ship', 'flip', 'flag', 'trim',
  'scan', 'wrap', 'swap', 'pin', 'tap', 'pop', 'crop',
  // multisyllables with final-syllable stress
  'cancel', 'submit', 'commit', 'permit', 'transmit', 'omit', 'admit',
  'refer', 'prefer', 'defer', 'occur', 'equip', 'control', 'patrol',
  'forget', 'regret', 'upset', 'reset', 'unzip', 'overrun',
]);

function shouldDoubleFinalConsonant(verb: string): boolean {
  return DOUBLING_VERBS.has(verb);
}

/**
 * Whether `verb` ends in a `-y` preceded by a consonant — those convert to
 * `-i` before `-ed` (reply → replied, try → tried) but keep `-y` before
 * `-ing` (replying, trying). When the `-y` is preceded by a vowel, no
 * transformation happens (play → playing/played).
 */
function endsWithConsonantY(verb: string): boolean {
  if (verb.length < 2 || !verb.endsWith('y')) return false;
  const beforeLast = verb[verb.length - 2];
  return !VOWELS.has(beforeLast);
}

function conjugatePresent(verb: string): string {
  const lower = verb.toLowerCase();
  if (IRREGULAR_VERBS[lower]) return IRREGULAR_VERBS[lower].present;
  if (shouldDoubleFinalConsonant(lower)) return `${lower}${lower.slice(-1)}ing`;
  if (endsWithConsonantY(lower)) return `${lower}ing`;
  if (lower.endsWith('e') && !lower.endsWith('ee')) return `${lower.slice(0, -1)}ing`;
  return `${lower}ing`;
}

function conjugatePast(verb: string): string {
  const lower = verb.toLowerCase();
  if (IRREGULAR_VERBS[lower]) return IRREGULAR_VERBS[lower].past;
  if (shouldDoubleFinalConsonant(lower)) return `${lower}${lower.slice(-1)}ed`;
  if (endsWithConsonantY(lower)) return `${lower.slice(0, -1)}ied`;
  if (lower.endsWith('e')) return `${lower}d`;
  return `${lower}ed`;
}

export function inferTenseForms(label: string): TenseForms {
  const trimmed = label.trim();
  if (!trimmed) return { future: label, present: label, past: label };
  const [verb, ...rest] = trimmed.split(/\s+/);
  const tail = rest.join(' ');
  const future = tail ? `${verb.toLowerCase()} ${tail}` : verb.toLowerCase();
  const present = capitalize(tail ? `${conjugatePresent(verb)} ${tail}` : conjugatePresent(verb));
  const past = capitalize(tail ? `${conjugatePast(verb)} ${tail}` : conjugatePast(verb));
  return { future, present, past };
}
