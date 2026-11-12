/**
 * Template grammar shared by Automate (backend runner, agent tools, window).
 *
 * One small language, validated on save so nothing unsupported is ever stored:
 *
 *   {{field}}  {{payload.field}}  {{a.b.0.c}}   dot path into the payload
 *   {{topic}}                                  the event topic (event triggers)
 *   {{payload}}                                the whole payload as JSON
 *   {{now.*}}                                  date/time of the execution
 *   {{a || b || "literal"}}                    first non-empty wins
 *
 * `now` family (rendered in the trigger's timezone — scheduler/once store one;
 * event/webhook render in UTC):
 *
 *   {{now}} {{now.datetime}}   2026-10-21 17:00
 *   {{now.date}}               2026-10-21
 *   {{now.time}}               17:00
 *   {{now.iso}}                2026-10-21T17:00:00.000Z (always UTC)
 *   {{now.year}} {{now.month}} {{now.day}}    2026 / 10 / 21
 *   {{now.hour}} {{now.minute}}               17 / 00
 *   {{now.weekday}}            Tuesday (English, en-US)
 *
 * Anything else — {{#if}}, {{else}}, {{/x}}, helpers, filters — is rejected by
 * `validateTemplate`. `renderTemplate` never throws: an unknown path renders
 * as an empty string so a bad template shows up as an empty title (which
 * Automate then refuses) rather than as a crash.
 */

/** Human-readable reference served to agents (list-event-topics) and the window. */
export const TEMPLATE_SYNTAX =
  'Placeholders: {{field}} or {{payload.field}} (dot paths allowed: {{a.b.0.c}}), {{topic}} (event topic), {{payload}} (whole payload as JSON). ' +
  'Date/time of the execution: {{now.date}} (2026-10-21), {{now.time}} (17:00), {{now.datetime}} or {{now}} (2026-10-21 17:00), {{now.iso}}, {{now.year}}, {{now.month}}, {{now.day}}, {{now.hour}}, {{now.minute}}, {{now.weekday}} (Tuesday) — rendered in the trigger timezone (scheduler/once) or UTC (event/webhook). ' +
  'Fallbacks: {{fromName || fromUsername || "unknown"}} — the first non-empty value wins, quoted text is a literal; now.* works inside fallbacks too ({{payload.title || now.date}}). ' +
  'Nothing else is supported: no {{#if}}, {{else}}, helpers or filters — such templates are rejected on save. ' +
  'For create-task the title and instructions templates are required and must not render empty.';

const PLACEHOLDER_RE = /\{\{([^{}]*)\}\}/g;
const PATH_RE = /^[A-Za-z_$][\w$]*(?:\.[\w$]+)*$/;
const QUOTED_RE = /^(?:"([^"]*)"|'([^']*)')$/;

export interface TemplateValidation {
  ok: boolean;
  /** Set when `ok` is false. */
  error?: string;
  /** Top-level payload fields the template reads (excludes `topic`, `now` and the whole-payload dump). */
  fields: string[];
}

type Alternative = { kind: 'path'; path: string } | { kind: 'literal'; value: string };

function parseExpression(raw: string): Alternative[] | string {
  const expr = raw.trim();
  if (!expr) return 'empty placeholder {{}}';
  if (/^[#/^!>]/.test(expr) || expr === 'else') {
    return `unsupported block syntax {{${expr}}} — only {{field}}, {{payload.field}}, {{topic}}, {{payload}}, {{now.*}} and {{a || b || "literal"}} are supported`;
  }
  const parts = expr.split('||').map((p) => p.trim());
  const alternatives: Alternative[] = [];
  for (const part of parts) {
    if (!part) return `empty alternative in {{${expr}}}`;
    const quoted = QUOTED_RE.exec(part);
    if (quoted) {
      alternatives.push({ kind: 'literal', value: quoted[1] ?? quoted[2] ?? '' });
      continue;
    }
    if (!PATH_RE.test(part)) {
      return `unsupported expression {{${expr}}} — "${part}" is neither a field path nor a quoted literal`;
    }
    alternatives.push({ kind: 'path', path: part });
  }
  return alternatives;
}

/** Top-level payload field of a path (`payload.a.b` → `a`, `a.b` → `a`, `payload` / `topic` / `now.*` → null). */
function fieldOf(path: string): string | null {
  if (path === 'payload' || path === 'topic' || path === 'now' || path.startsWith('now.')) return null;
  const clean = path.startsWith('payload.') ? path.slice('payload.'.length) : path;
  return clean.split('.')[0] || null;
}

/** Validate a template against the grammar. Never throws. */
export function validateTemplate(template: string): TemplateValidation {
  const fields = new Set<string>();
  // Unbalanced braces: a "{{" with no closing "}}" (or stray "}}")
  const opens = (template.match(/\{\{/g) ?? []).length;
  const closes = (template.match(/\}\}/g) ?? []).length;
  if (opens !== closes) return { ok: false, error: 'unbalanced {{ }} braces', fields: [] };
  for (const m of template.matchAll(PLACEHOLDER_RE)) {
    const parsed = parseExpression(m[1]);
    if (typeof parsed === 'string') return { ok: false, error: parsed, fields: [] };
    for (const alt of parsed) {
      if (alt.kind === 'path') {
        const f = fieldOf(alt.path);
        if (f) fields.add(f);
      }
    }
  }
  return { ok: true, fields: [...fields] };
}

/** Top-level payload fields a template reads (empty when the template is invalid). */
export function templateFields(template: string | undefined | null): string[] {
  if (!template) return [];
  return validateTemplate(template).fields;
}

/** Resolve a dot path ('a.b.0.c' — numeric segments are array indices). */
export function getDotPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(part);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

// ============================================================================
// now.* — date/time of the execution
// ============================================================================

/**
 * The execution instant plus the timezone to render it in. `timezone` is the
 * IANA zone stored on scheduler/once triggers; absent (event/webhook) → UTC.
 */
export interface TemplateNowContext {
  /** Execution instant as an ISO 8601 string (e.g. `2026-10-21T16:00:00.000Z`). */
  iso: string;
  /** IANA timezone for the human-readable fields (default UTC). */
  timezone?: string;
}

export interface TemplateRenderContext {
  /** Event topic, exposed as `{{topic}}`. */
  topic?: string;
  /** Execution instant, exposed as the `{{now.*}}` family. Absent → they render empty. */
  now?: TemplateNowContext;
}

/** `{{now}}` sub-paths that resolve to a formatted date/time (unknown ones render empty). */
const NOW_SUBS = new Set(['datetime', 'date', 'time', 'iso', 'year', 'month', 'day', 'hour', 'minute', 'weekday']);

/**
 * Deterministic formatting (no system-locale `toLocaleString`): fixed numeric
 * options via `Intl.DateTimeFormat.formatToParts`, DST-safe because the
 * formatter resolves the instant in the given zone.
 */
function zonedParts(iso: string, timezone: string | undefined, opts: Intl.DateTimeFormatOptions): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'UTC',
    hour12: false,
    ...opts,
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), weekday: get('weekday') };
}

/** Formatter options per `{{now.*}}` sub-path (all numeric, en-US parts). */
const NOW_OPTS: Record<string, Intl.DateTimeFormatOptions> = {
  datetime: { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' },
  date: { year: 'numeric', month: '2-digit', day: '2-digit' },
  time: { hour: '2-digit', minute: '2-digit' },
  year: { year: 'numeric' },
  month: { month: '2-digit' },
  day: { day: '2-digit' },
  hour: { hour: '2-digit' },
  minute: { minute: '2-digit' },
  weekday: { weekday: 'long' },
};

/**
 * Render one `now.*` variable from the execution instant + timezone.
 * Returns undefined for unknown sub-paths (and when the instant is invalid) —
 * the caller renders those as empty, like any other unknown path.
 * Exported for the runner tests (title uniqueness across executions).
 */
export function renderNowVariable(sub: string, now: TemplateNowContext): string | undefined {
  if (sub === '') return renderNowVariable('datetime', now);
  if (!NOW_SUBS.has(sub)) return undefined;
  const date = new Date(now.iso);
  if (Number.isNaN(date.getTime())) return undefined;
  if (sub === 'iso') return date.toISOString(); // always UTC — it is an ISO timestamp
  const p = zonedParts(now.iso, now.timezone, NOW_OPTS[sub]!);
  if (sub === 'weekday') return p.weekday; // en-US long weekday, e.g. "Tuesday"
  if (sub === 'datetime') return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  if (sub === 'date') return `${p.year}-${p.month}-${p.day}`;
  if (sub === 'time') return `${p.hour}:${p.minute}`;
  // ICU quirk: standalone numeric parts ignore 2-digit padding (minute "0"
  // instead of "00") — pad here so {{now.minute}} is always two digits.
  return p[sub]!.padStart(2, '0');
}

/**
 * Render a template against a payload. `context.topic` is exposed as
 * `{{topic}}`; `{{payload}}` dumps the payload as JSON; `context.now` feeds
 * the `{{now.*}}` family (absent → they render empty). The `now` context wins
 * over a payload field of the same name — a payload can never override it.
 * Unknown paths and invalid placeholders render as empty strings — validate
 * on save instead.
 */
export function renderTemplate(
  template: string,
  payload: Record<string, unknown>,
  context: TemplateRenderContext = {},
): string {
  return template.replace(PLACEHOLDER_RE, (_match, raw: string) => {
    const parsed = parseExpression(raw);
    if (typeof parsed === 'string') return '';
    for (const alt of parsed) {
      if (alt.kind === 'literal') {
        if (alt.value !== '') return alt.value;
        continue;
      }
      let value: unknown;
      if (alt.path === 'payload') value = JSON.stringify(payload);
      else if (alt.path === 'topic') value = context.topic;
      else if (alt.path === 'now' || alt.path.startsWith('now.')) {
        // Context wins over the payload: resolve from context.now only.
        value = context.now ? renderNowVariable(alt.path.slice('now'.length + 1), context.now) : undefined;
      } else {
        const clean = alt.path.startsWith('payload.') ? alt.path.slice('payload.'.length) : alt.path;
        value = getDotPath(payload, clean);
        // `{{topic}}` may also travel inside the payload when the caller merged it in
        if (value === undefined && clean === 'topic') value = context.topic;
      }
      if (!isEmpty(value)) return stringify(value);
    }
    return '';
  });
}
