/**
 * Natural-language schedule parsing — "cada lunes a las 9" → "0 9 * * 1".
 *
 * The PRIMARY way to create a recurring automation (v1.4.4): nobody but
 * engineers reads cron, so the schedule trigger accepts plain language and
 * the raw 5-field expression stays as the advanced mode. Shared by the
 * Automate agent tools (MCA), the backend preview handler and the Automate
 * window form, so all three translate and describe identically.
 *
 * Supported shapes (en + es, case-insensitive):
 *   - "cada lunes a las 9" / "every monday at 9am"      → 0 9 * * 1
 *   - "lunes, miércoles y viernes a las 9"              → 0 9 * * 1,3,5
 *   - "weekdays a las 8" / "días laborables a las 8"    → 0 8 * * 1-5
 *   - "de lunes a viernes a las 9" / "monday to friday at 8" → 0 9 * * 1-5 / 0 8 * * 1-5
 *   - "todos los días a las 9" / "every day at 9"       → 0 9 * * *
 *   - "cada 2 horas" / "every 2 hours"                  → 0 (every-2-hours) * * *
 *   - "cada 15 minutos" / "every 15 minutes"            → (every-15-min) * * * *
 *   - "el primer día de mes" / "first day of every month" → 0 0 1 * *
 *   - "cada día 15 a las 10" / "on the 15th at 10"      → 0 10 15 * *
 *   - "a las 9" (daily implied) / "at 9am"              → 0 9 * * *
 *
 * This module is PURE: no croner, no MCA error types. Untranslatable input
 * returns { ok: false, error } — the caller decides how to surface it.
 */

export interface ParsedSchedule {
  /** Canonical 5-field cron expression. */
  cron: string;
  /** The fragment of the input the translation was built from. */
  detectedText: string;
  /** Human-readable description of the schedule (same string describeScheduleCron produces). */
  description: string;
}

export type ScheduleParseResult =
  | { ok: true; cron: string; detectedText: string; description: string }
  | { ok: false; error: string; suggestion: string };

/** Per-field bounds by position: minute hour day-of-month month day-of-week. */
const CRON_FIELD_BOUNDS: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

/**
 * Pure 5-field cron check: shape AND per-field bounds, so "0 25 * * *" is
 * rejected locally without croner. Day-of-week allows 0-7 (7 = Sunday, the
 * same tolerance croner has). Semantics beyond this are validated by the
 * caller with croner.
 */
export function isFiveFieldCron(input: string): boolean {
  const fields = input.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((f, i) => {
    const [min, max] = CRON_FIELD_BOUNDS[i];
    if (f === '*') return true;
    // step, list, range or plain number, within this field's bounds
    return f.split(',').every((part) => {
      if (part === '*') return true;
      const stepM = part.match(/^(\*|\d+|\d+-\d+)\/(\d+)$/);
      if (stepM) {
        if (parseInt(stepM[2], 10) < 1) return false;
      }
      const base = stepM ? stepM[1] : part;
      if (base === '*') return true; // "*/n" step from the field minimum
      const rangeM = base.match(/^(\d+)-(\d+)$/);
      if (rangeM) {
        const a = parseInt(rangeM[1], 10);
        const b = parseInt(rangeM[2], 10);
        return a >= min && a <= max && b >= min && b <= max && a <= b;
      }
      if (!/^\d+$/.test(base)) return false;
      const n = parseInt(base, 10);
      return n >= min && n <= max;
    });
  });
}

/**
 * The natural-language text for a cron, WITHOUT the "Se ejecutará:" / "Runs:"
 * prefix — the shape that goes into an editable NL field and re-parses back
 * to the same cron ("lunes, miércoles y viernes a las 09:00"). Not every cron
 * has an NL shape that round-trips (hour lists/ranges); callers that need the
 * guarantee verify it with parseScheduleExpression and fall back to the cron
 * itself, which parses as a passthrough.
 */
export function cronToScheduleText(cron: string, locale: 'en' | 'es' = 'en'): string {
  const described = describeScheduleCron(cron, locale);
  const es = locale === 'es';
  const prefix = es ? 'Se ejecutará: ' : 'Runs: ';
  return described.startsWith(prefix) ? described.slice(prefix.length) : described;
}

// ---------------------------------------------------------------------------
// Vocabulary (en + es)
// ---------------------------------------------------------------------------

const DAYS: Record<string, number> = {
  // English
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
  // Spanish
  domingo: 0, dom: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3, miércoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6, sábado: 6,
};

const WEEKDAYS_WORDS = ['weekdays', 'weekday', 'laborables', 'laborable', 'días laborables', 'dias laborables', 'laborables'];
const EVERYDAY_WORDS = ['daily', 'every day', 'everyday', 'todos los días', 'todos los dias', 'cada día', 'cada dia', 'a diario'];
const MONTH_DAY_WORDS = [
  'primer día de mes', 'primer dia de mes', 'primer día del mes', 'primer dia del mes',
  'first day of every month', 'first day of the month', 'first of every month', 'first of the month',
  'day 1 of every month', 'el 1 de cada mes', '1 de cada mes',
];

const TIME_RE = /(?:\ba\s+las\s+|\bat\s+|@)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|de la mañana|de la tarde|de la noche|h)?\b/i;
const EVERY_N_RE = /(?:cada|every|each)\s+(\d{1,3})\s*(minutos?|minutes?|mins?|horas?|hours?|hrs?|h|días?|dias?|days?)\b/i;
const DAY_N_RE = /(?:día|dia|day)\s+(\d{1,2})\b|(?:el\s+)?(\d{1,2})(?:º|°|st|nd|rd|th)?\s+(?:de\s+)?(?:cada\s+)?mes\b|on\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\b/i;

/** Normalize an accented/lowercased input for matching. */
function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse "9", "9:30", "9am", "21:00", "9 de la tarde" → { hour, minute }.
 * Prefers an explicitly-prefixed time ("a las 10", "at 10am") over a bare
 * number, so "día 15 a las 10" reads 10:00 and not the day number 15.
 */
function parseTime(text: string): { hour: number; minute: number; matched: string } | null {
  const prefixed = text.match(/(?:\ba\s+las\s+|\bat\s+)(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|de la mañana|de la tarde|de la noche)?\b/i);
  const m = prefixed ?? text.match(TIME_RE);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  if (Number.isNaN(hour) || Number.isNaN(minute) || hour > 23 || minute > 59) return null;
  const meridiem = m[3]?.toLowerCase();
  if (meridiem) {
    if ((meridiem.startsWith('p') || meridiem.includes('tarde') || meridiem.includes('noche')) && hour < 12) hour += 12;
    else if ((meridiem.startsWith('a') || meridiem.includes('mañana') || meridiem.includes('manana')) && hour === 12) hour = 0;
    else if (meridiem === 'h') { /* 24h marker, no shift */ }
  }
  if (hour > 23) return null;
  return { hour, minute, matched: m[0].trim() };
}

function cronField(values: number[], min: number, max: number): string | null {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  if (sorted.length === 0) return '*';
  for (const v of sorted) {
    if (v < min || v > max) return null;
  }
  // Contiguous run of 3+ → range (1,2,3,4,5 → 1-5); otherwise a list.
  if (sorted.length >= 3 && sorted[sorted.length - 1] - sorted[0] === sorted.length - 1) {
    return `${sorted[0]}-${sorted[sorted.length - 1]}`;
  }
  return sorted.join(',');
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

export function parseScheduleExpression(input: string, locale: 'en' | 'es' = 'en'): ScheduleParseResult {
  const raw = input.trim();
  if (!raw) return fail('Schedule expression is empty.', 'Type a schedule like "cada lunes a las 9" or a 5-field cron.');

  // Already a cron? Pass through (advanced mode). Structural check here;
  // the caller re-validates semantics with croner before saving.
  if (isFiveFieldCron(raw)) {
    return { ok: true as const, cron: raw.replace(/\s+/g, ' '), detectedText: raw, description: describeScheduleCron(raw) };
  }

  const text = normalize(raw);

  // --- "every N minutes/hours/days" ---------------------------------------
  const everyN = text.match(EVERY_N_RE);
  if (everyN) {
    const n = parseInt(everyN[1], 10);
    const unit = everyN[2].toLowerCase();
    if (n >= 1) {
      if (unit.startsWith('min')) {
        if (n > 59) return fail(`Cannot run every ${n} minutes.`, 'The minimum interval is 1 minute.');
        return { ok: true as const, cron: `*/${n} * * * *`, detectedText: everyN[0], description: `Every ${n} minutes` };
      }
      if (unit.startsWith('h')) {
        if (n > 23) return fail(`Cannot run every ${n} hours.`, 'Use 1-23 hours, or a day-of-week schedule.');
        return { ok: true as const, cron: `0 */${n} * * *`, detectedText: everyN[0], description: `Every ${n} hours` };
      }
      if (unit.startsWith('d') || unit.startsWith('dí') || unit.startsWith('di')) {
        if (n > 31) return fail(`Cannot run every ${n} days.`, 'Use 1-31 days.');
        return { ok: true as const, cron: `0 0 */${n} * *`, detectedText: everyN[0], description: `Every ${n} days` };
      }
    }
  }

  // --- first day of month ---------------------------------------------------
  for (const w of MONTH_DAY_WORDS) {
    if (text.includes(w)) {
      const t = parseTime(text.replace(w, ' '));
      const time = t ?? { hour: 0, minute: 0 };
      return {
        ok: true as const,
        cron: `${time.minute} ${time.hour} 1 * *`,
        detectedText: raw,
        description: `First day of every month at ${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`,
      };
    }
  }

  // --- specific day-of-month ("día 15 a las 10", "on the 15th at 10") ------
  const dayN = text.match(DAY_N_RE);
  if (dayN) {
    const day = parseInt(dayN[1] ?? dayN[2] ?? dayN[3], 10);
    if (day >= 1 && day <= 31) {
      const t = parseTime(text);
      const time = t ?? { hour: 0, minute: 0 };
      return {
        ok: true as const,
        cron: `${time.minute} ${time.hour} ${day} * *`,
        detectedText: raw,
        description: `On day ${day} of every month at ${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`,
      };
    }
  }

  // --- day ranges ("lunes a viernes", "monday to friday", "lunes-viernes") --
  // Checked BEFORE the day-list scan: "días laborables (lunes a viernes)" and
  // a bare "de lunes a viernes" both mean the Mon-Fri RANGE, not the list {1,5}.
  const dayRangeRe = new RegExp(
    `\\b(${Object.keys(DAYS).join('|')})s?\\s*(?:a|al|hasta|to|until|-|—)\\s*(${Object.keys(DAYS).join('|')})s?\\b`,
    'i',
  );
  const rangeM = dayRangeRe.exec(text);
  if (rangeM) {
    const a = DAYS[rangeM[1].toLowerCase()];
    let b = DAYS[rangeM[2].toLowerCase()];
    if (a !== undefined && b !== undefined) {
      if (b === 0 && a > 0) b = 7; // "martes a domingo" wraps to 2-7 (7 = Sunday)
      if (a >= b) {
        return fail('The day range is inverted or empty.', 'Put the earlier day first, e.g. "lunes a viernes".');
      }
      const t = parseTime(text);
      const time = t ?? { hour: 9, minute: 0 };
      const cron = `${time.minute} ${time.hour} * * ${a}-${b}`;
      return { ok: true as const, cron, detectedText: raw, description: describeScheduleCron(cron, locale) };
    }
  }

  // --- day-of-week schedules ------------------------------------------------
  const weekdayNames: string[] = [];
  let cursor = text;
  // Collect every day-of-week token in the text ("lunes, miércoles y viernes").
  // English plurals ("mondays", "tuesdays") — match with an optional trailing s.
  const dayTokenRe = new RegExp(`\\b(${Object.keys(DAYS).join('|')})s?\\b`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = dayTokenRe.exec(text)) !== null) {
    const day = DAYS[m[1].toLowerCase()];
    if (day !== undefined && !weekdayNames.includes(m[1])) weekdayNames.push(m[1]);
  }

  if (weekdayNames.length > 0) {
    const days = weekdayNames.map((name) => DAYS[name]);
    const field = cronField(days, 0, 6);
    if (field === null) return fail('A day name in the expression is out of range.', 'Check the day names in the expression.');
    const t = parseTime(cursor);
    const time = t ?? { hour: 9, minute: 0 };
    const cron = `${time.minute} ${time.hour} * * ${field}`;
    return { ok: true as const, cron, detectedText: raw, description: describeScheduleCron(cron, locale) };
  }

  // --- weekdays (Mon-Fri) ---------------------------------------------------
  for (const w of WEEKDAYS_WORDS) {
    if (text.includes(w)) {
      const t = parseTime(text.replace(w, ' '));
      const time = t ?? { hour: 9, minute: 0 };
      const cron = `${time.minute} ${time.hour} * * 1-5`;
      return { ok: true as const, cron, detectedText: raw, description: describeScheduleCron(cron, locale) };
    }
  }

  // --- every day ------------------------------------------------------------
  for (const w of EVERYDAY_WORDS) {
    if (text.includes(w)) {
      const t = parseTime(text.replace(w, ' '));
      const time = t ?? { hour: 9, minute: 0 };
      const cron = `${time.minute} ${time.hour} * * *`;
      return { ok: true as const, cron, detectedText: raw, description: describeScheduleCron(cron, locale) };
    }
  }

  // --- bare time ("a las 9" → daily at 9) ----------------------------------
  const bareTime = parseTime(text);
  if (bareTime && text.replace(TIME_RE, '').replace(/[\s,]/g, '').length === 0) {
    const cron = `${bareTime.minute} ${bareTime.hour} * * *`;
    return { ok: true as const, cron, detectedText: bareTime.matched, description: describeScheduleCron(cron, locale) };
  }

  return fail(
    `Could not translate "${raw}" into a recurring schedule.`,
    'Try: "cada lunes a las 9", "weekdays a las 8", "cada 2 horas", "cada 15 minutos", "el primer día de mes", "todos los días a las 9:30", or a 5-field cron (advanced).',
  );
}

function fail(error: string, suggestion: string): ScheduleParseResult {
  return { ok: false, error, suggestion };
}

// ---------------------------------------------------------------------------
// Human description of a cron (always shown — the user never decodes cron)
// ---------------------------------------------------------------------------

const DAY_NAMES_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_NAMES_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** Parse one cron field into its values (supports *, lists, ranges, steps). */
function fieldValues(field: string, min: number, max: number): number[] | 'all' {
  if (field === '*') return 'all';
  const out: number[] = [];
  for (const part of field.split(',')) {
    const stepM = part.match(/^\*\/(\d+)$/);
    const rangeM = part.match(/^(\d+)-(\d+)$/);
    if (stepM) {
      const step = parseInt(stepM[1], 10);
      for (let v = min; v <= max; v += step) out.push(v);
    } else if (rangeM) {
      const a = parseInt(rangeM[1], 10);
      const b = parseInt(rangeM[2], 10);
      for (let v = a; v <= b; v++) out.push(v);
    } else {
      const v = parseInt(part, 10);
      if (!Number.isNaN(v)) out.push(v);
    }
  }
  return out;
}

/**
 * Describe a 5-field cron in plain language. Locale 'en' (default) or 'es'.
 * This is the ALWAYS-ON preview: every schedule (natural or raw cron) is
 * shown as "Se ejecutará: lunes, miércoles y viernes a las 09:00", never
 * as "0 9 * * 1,3,5".
 */
export function describeScheduleCron(cron: string, locale: 'en' | 'es' = 'en'): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [minF, hourF, domF, monF, dowF] = parts;
  const es = locale === 'es';

  // Time part
  const minutes = fieldValues(minF, 0, 59);
  const hours = fieldValues(hourF, 0, 23);
  const minuteStr = minF === '*' ? '' : `:${String(minutes === 'all' ? 0 : (minutes as number[])[0]).padStart(2, '0')}`;
  const hourStepM = hourF.match(/^\*\/(\d+)$/);
  const hourRangeM = hourF.match(/^(\d+)-(\d+)$/);
  let timePart: string;
  if (hourF === '*') {
    timePart = es ? 'a cualquier hora' : 'every hour';
  } else if (hourStepM) {
    timePart = es ? `cada ${hourStepM[1]} horas` : `every ${hourStepM[1]} hours`;
  } else if (hourRangeM) {
    const from = String(parseInt(hourRangeM[1], 10)).padStart(2, '0');
    const to = String(parseInt(hourRangeM[2], 10)).padStart(2, '0');
    timePart = es ? `de ${from}:00 a ${to}:00` : `from ${from}:00 to ${to}:00`;
  } else {
    const hs = (hours === 'all' ? [] : hours as number[]).map((h) => String(h).padStart(2, '0'));
    if (hs.length === 1) {
      timePart = es ? `a las ${hs[0]}${minuteStr}` : `at ${hs[0]}${minuteStr}`;
    } else {
      timePart = es ? `a las ${hs.map((h) => `${h}${minuteStr}`).join(', ')}` : `at ${hs.map((h) => `${h}${minuteStr}`).join(', ')}`;
    }
  }

  // Minute step ("*/15 * * * *" → every 15 minutes)
  const minStepM = minF.match(/^\*\/(\d+)$/);
  if (minStepM && hourF === '*') {
    return es ? `cada ${minStepM[1]} minutos` : `every ${minStepM[1]} minutes`;
  }

  // Day part
  const names = es ? DAY_NAMES_ES : DAY_NAMES_EN;
  let dayPart: string;
  if (dowF === '*' && domF === '*' && monF === '*') {
    dayPart = es ? 'todos los días' : 'every day';
  } else if (domF !== '*') {
    const doms = fieldValues(domF, 1, 31);
    const list = doms === 'all' ? domF : (doms as number[]).join(', ');
    dayPart = es ? `el día ${list} de cada mes` : `on day ${list} of every month`;
  } else if (dowF !== '*') {
    // 7 is the Sunday alias: normalize to 0 before mapping names.
    const dowsRaw = fieldValues(dowF, 0, 7);
    const dows = dowsRaw === 'all' ? 'all' : [...new Set((dowsRaw as number[]).map((d) => (d === 7 ? 0 : d)))];
    const dowRangeM = dowF.match(/^(\d+)-(\d+)$/);
    if (dowF === '1-5') {
      dayPart = es ? 'días laborables (lunes a viernes)' : 'weekdays (Monday to Friday)';
    } else if (dowRangeM && dows !== 'all') {
      const from = parseInt(dowRangeM[1], 10);
      const to = parseInt(dowRangeM[2], 10) === 7 ? 0 : parseInt(dowRangeM[2], 10);
      dayPart = es ? `de ${names[from]} a ${names[to]}` : `from ${names[from]} to ${names[to]}`;
    } else if (dows !== 'all') {
      const sorted = [...dows].sort((a, b) => a - b);
      // Sunday-first cron order → reorder Monday-first for reading.
      const reading = sorted.slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
      const dayNames = reading.map((d) => names[d]);
      dayPart = es
        ? dayNames.length === 1 ? dayNames[0] : `${dayNames.slice(0, -1).join(', ')} y ${dayNames[dayNames.length - 1]}`
        : dayNames.length === 1 ? dayNames[0] : `${dayNames.slice(0, -1).join(', ')} and ${dayNames[dayNames.length - 1]}`;
    } else {
      dayPart = es ? 'todos los días' : 'every day';
    }
  } else {
    dayPart = es ? 'todos los días' : 'every day';
  }

  return es ? `Se ejecutará: ${dayPart} ${timePart}` : `Runs: ${dayPart} ${timePart}`;
}
