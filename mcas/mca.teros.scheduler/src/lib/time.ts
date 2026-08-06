import * as chrono from 'chrono-node';
import { SchedulerError } from './errors';

export type ParseLocale = 'en' | 'es';

export interface ParseTimeOptions {
  reference?: Date;
  timezone: string;
  locale?: ParseLocale;
  allowPast?: boolean;
}

export interface ParsedTime {
  date: Date;
  timestamp: number;
  confidence: 'high' | 'medium';
  locale: ParseLocale;
  detectedText: string;
  remainingText: string;
}

const ISO_LIKE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})/;

interface ChronoNamespace {
  parse: (
    text: string,
    ref?: { instant: Date; timezone?: string } | Date,
    opts?: { forwardDate?: boolean },
  ) => Array<{ text: string; date(): Date; start: { isCertain(field: string): boolean } }>;
}
function pickParser(locale?: ParseLocale): { parser: ChronoNamespace; locale: ParseLocale } {
  if (locale === 'es' && chrono.es) return { parser: chrono.es as unknown as ChronoNamespace, locale: 'es' };
  return { parser: chrono.en as unknown as ChronoNamespace, locale: 'en' };
}

/**
 * Get the IANA timezone offset in ms at a given instant.
 * `at + offset = wall-clock`, e.g. for `Europe/Madrid` in summer, offset is +7_200_000.
 */
function tzOffsetAt(at: Date, tz: string): number {
  const pad = (parts: Intl.DateTimeFormatPart[]): number => {
    const o = Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
    const hour = Number(o.hour) === 24 ? 0 : Number(o.hour);
    return Date.UTC(Number(o.year), Number(o.month) - 1, Number(o.day), hour, Number(o.minute), Number(o.second));
  };
  const utcParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const tzParts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  return pad(tzParts) - pad(utcParts);
}

/**
 * Reinterpret a Date that chrono produced using the SERVER local TZ as if its
 * literal hour/minute components had been entered in `targetTz` instead.
 *
 * Bug context (P1-1, audit TER-186 2026-05-06): chrono's `ref.timezone` only
 * affects DAY anchoring (today/tomorrow/yesterday) — literal hour tokens like
 * "9am" are interpreted in the runtime's local TZ. This helper post-processes
 * the result so "tomorrow at 9am" with timezone:"America/New_York" actually
 * lands at 9am NY, not 9am Madrid.
 *
 * Algorithm:
 *   parsed.UTC + serverOffset = wall_clock_in_server   (chrono produced this)
 *   Y.UTC      + targetOffset = wall_clock_in_target   (we want same wall_clock)
 *   ⇒ Y = parsed + serverOffset − targetOffset
 */
function reinterpretLiteralHourInTimezone(parsed: Date, targetTz: string): Date {
  const serverTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (serverTz === targetTz) return parsed;
  const serverOffset = tzOffsetAt(parsed, serverTz);
  const targetOffset = tzOffsetAt(parsed, targetTz);
  return new Date(parsed.getTime() + serverOffset - targetOffset);
}

export function parseTimeExpression(input: string, opts: ParseTimeOptions): ParsedTime {
  if (!input || !input.trim()) {
    throw new SchedulerError('INVALID_INPUT', 'Time expression is empty.');
  }

  const reference = opts.reference ?? new Date();

  if (ISO_LIKE.test(input.trim())) {
    const parsed = new Date(input.trim());
    if (Number.isNaN(parsed.getTime())) {
      throw new SchedulerError(
        'INVALID_TIME_EXPRESSION',
        `Could not parse ISO time "${input}".`,
        'Use "YYYY-MM-DDTHH:MM[:SS]" (optionally with timezone offset).',
      );
    }
    if (!opts.allowPast && parsed.getTime() < reference.getTime()) {
      throw new SchedulerError(
        'PAST_TIME_NOT_ALLOWED',
        `Time "${input}" is in the past.`,
        'Pass allowPast:true to schedule retroactively (rare).',
      );
    }
    return {
      date: parsed,
      timestamp: parsed.getTime(),
      confidence: 'high',
      locale: opts.locale ?? 'en',
      detectedText: input.trim(),
      remainingText: '',
    };
  }

  const { parser, locale } = pickParser(opts.locale);
  const results = parser.parse(input, { instant: reference, timezone: opts.timezone }, { forwardDate: true });

  if (results.length === 0) {
    throw new SchedulerError(
      'INVALID_TIME_EXPRESSION',
      `Could not parse time expression "${input}" (locale=${locale}).`,
      'Try: "in 2 hours", "tomorrow at 9am", "every Monday at 14:00", or ISO 8601.',
    );
  }
  if (results.length > 1) {
    throw new SchedulerError(
      'AMBIGUOUS_TIME_EXPRESSION',
      `Expression "${input}" matched ${results.length} times.`,
      'Be more specific — pick a single time.',
    );
  }

  const r = results[0];
  const certainHour = r.start.isCertain('hour');
  const certainDay = r.start.isCertain('day');
  let date = r.date();

  // P1-1 fix: when the user wrote a literal hour ("at 9am", "9:00pm", "noon"),
  // chrono interprets it in the server's local TZ instead of opts.timezone.
  // Detect by looking for explicit time tokens in the matched text — relative
  // expressions like "in 2 hours" never contain these and must be left alone.
  // chrono.start.isCertain('hour') is unreliable here (returns true even for
  // computed-relative results), so we use a text heuristic.
  const LITERAL_HOUR_RE = /(\d{1,2}\s?(?:am|pm)|\d{1,2}[:h]\d{2}|\bnoon\b|\bmidnight\b|\bmediod[ií]a\b|\bmedianoche\b)/i;
  if (LITERAL_HOUR_RE.test(r.text)) {
    date = reinterpretLiteralHourInTimezone(date, opts.timezone);
  }

  if (!opts.allowPast && date.getTime() < reference.getTime()) {
    throw new SchedulerError(
      'PAST_TIME_NOT_ALLOWED',
      `Parsed time "${date.toISOString()}" is in the past.`,
      'Be more specific or pass allowPast:true.',
    );
  }

  return {
    date,
    timestamp: date.getTime(),
    confidence: certainHour && certainDay ? 'high' : 'medium',
    locale,
    detectedText: r.text,
    remainingText: input.replace(r.text, '').trim(),
  };
}

export function parseDelayExpression(input: string): number {
  const m = input.trim().match(/^(\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/i);
  if (!m) {
    throw new SchedulerError(
      'INVALID_INPUT',
      `Could not parse delay "${input}".`,
      'Use "30m", "2h", "1d" (s/m/h/d).',
    );
  }
  const value = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (unit.startsWith('s')) return value * 1000;
  if (unit.startsWith('mi') || unit === 'm') return value * 60_000;
  if (unit.startsWith('h')) return value * 3_600_000;
  if (unit.startsWith('d')) return value * 86_400_000;
  return 0;
}

export function formatNextRun(timestamp: number, timezone: string, now = Date.now()): string {
  const diffMs = timestamp - now;
  const absMs = Math.abs(diffMs);
  const past = diffMs < 0;
  const min = Math.round(absMs / 60_000);

  if (absMs < 60_000) return past ? 'just now' : 'in <1 minute';
  if (min < 60) return past ? `${min} minute${min === 1 ? '' : 's'} ago` : `in ${min} minute${min === 1 ? '' : 's'}`;
  const hours = Math.round(min / 60);
  if (hours < 24)
    return past ? `${hours} hour${hours === 1 ? '' : 's'} ago` : `in ${hours} hour${hours === 1 ? '' : 's'}`;

  const days = Math.round(hours / 24);
  if (days < 7) {
    if (past) return `${days} day${days === 1 ? '' : 's'} ago`;
    if (days === 1) {
      const t = new Date(timestamp).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZone: timezone,
      });
      return `tomorrow at ${t}`;
    }
    return `in ${days} days`;
  }
  return new Date(timestamp).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: timezone,
  });
}

export function previewOccurrences(
  expression: string,
  opts: ParseTimeOptions,
  count = 5,
): ParsedTime[] {
  if (count < 1) return [];
  const occurrences: ParsedTime[] = [];
  let reference = opts.reference ?? new Date();
  for (let i = 0; i < count; i++) {
    try {
      const parsed = parseTimeExpression(expression, { ...opts, reference });
      occurrences.push(parsed);
      reference = new Date(parsed.timestamp + 1);
    } catch {
      break;
    }
  }
  return occurrences;
}
