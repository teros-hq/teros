import { DateTime } from 'luxon';
import type { ToolConfig } from '@teros/mca-sdk';

/**
 * Base type for the 8 datetime tools. All of them are pure functions over
 * luxon: no state, no side effects, no secrets, no context usage — hence
 * readOnlyHint + idempotentHint on every one.
 */
export type DateTimeTool<TArgs = Record<string, unknown>, TResult = unknown> = ToolConfig<
  TArgs,
  TResult
>;

/**
 * Smart datetime parser that accepts:
 * - ISO 8601 strings ("2026-10-08T06:00:00Z", "2026-10-08")
 * - Unix timestamps in seconds (1791439748) or milliseconds (1791439748000)
 * - Unix timestamps as strings ("1791439748", "1791439748000")
 * - RFC 2822 ("Thu, 08 Oct 2026 06:00:00 GMT")
 * - HTTP date format
 * - SQL ("2026-10-08 06:00:00")
 * - Common human formats ("08/10/2026", "10/08/2026 14:30")
 *
 * Optionally accepts an explicit format string (Luxon tokens) as fallback.
 */
export function smartParse(datetime: string | number, format?: string): DateTime {
  // If a format is explicitly given, use it directly
  if (format) {
    const dt = DateTime.fromFormat(String(datetime), format);
    if (dt.isValid) return dt;
    throw new Error(
      `Invalid datetime "${datetime}" for format "${format}": ${dt.invalidReason}. ` +
      `Luxon format tokens: yyyy=year, MM=month, dd=day, HH=hour(24), mm=minute, ss=second, cccc=weekday, MMMM=month name`
    );
  }

  const input = String(datetime).trim();

  // Try Unix timestamp (pure number, seconds or milliseconds)
  if (/^\d{10}$/.test(input)) {
    // 10 digits = seconds
    const dt = DateTime.fromSeconds(Number(input), { zone: 'utc' });
    if (dt.isValid) return dt;
  }
  if (/^\d{13}$/.test(input)) {
    // 13 digits = milliseconds
    const dt = DateTime.fromMillis(Number(input), { zone: 'utc' });
    if (dt.isValid) return dt;
  }

  // Try ISO 8601
  let dt = DateTime.fromISO(input);
  if (dt.isValid) return dt;

  // Try RFC 2822
  dt = DateTime.fromRFC2822(input);
  if (dt.isValid) return dt;

  // Try HTTP date
  dt = DateTime.fromHTTP(input);
  if (dt.isValid) return dt;

  // Try SQL
  dt = DateTime.fromSQL(input);
  if (dt.isValid) return dt;

  // Try common human formats
  const humanFormats = [
    'yyyy-MM-dd HH:mm:ss',
    'yyyy-MM-dd HH:mm',
    'yyyy-MM-dd',
    'dd/MM/yyyy HH:mm:ss',
    'dd/MM/yyyy HH:mm',
    'dd/MM/yyyy',
    'MM/dd/yyyy HH:mm:ss',
    'MM/dd/yyyy HH:mm',
    'MM/dd/yyyy',
    'd MMMM yyyy',
    'd MMM yyyy',
    'MMMM d, yyyy',
    'MMM d, yyyy',
  ];

  for (const fmt of humanFormats) {
    dt = DateTime.fromFormat(input, fmt);
    if (dt.isValid) return dt;
  }

  throw new Error(
    `Cannot parse "${input}". Accepted formats: ISO 8601, Unix timestamp (seconds or ms), ` +
    `RFC 2822, SQL, or common formats like "yyyy-MM-dd HH:mm:ss", "dd/MM/yyyy", etc.`
  );
}

/**
 * Normalize a format string. Accepts both Luxon and Moment.js style tokens.
 * Converts Moment.js tokens to Luxon equivalents.
 */
export function normalizeFormat(format: string): string {
  // If it already looks like Luxon (lowercase yyyy, dd, etc.), return as-is
  // Simple heuristic: if it contains 'YYYY' or 'DD' or 'dddd', it's Moment.js style
  if (/YYYY|DD|dddd|ddd|MMMM/.test(format)) {
    return format
      .replace(/YYYY/g, 'yyyy')
      .replace(/YY/g, 'yy')
      .replace(/DD/g, 'dd')
      .replace(/dddd/g, 'cccc')
      .replace(/ddd/g, 'ccc')
      .replace(/MMMM/g, 'LLLL')
      .replace(/MMM/g, 'LLL')
      .replace(/D/g, 'd')
      .replace(/MM/g, 'MM')  // MM is same in both
      .replace(/HH/g, 'HH')  // HH is same in both
      .replace(/mm/g, 'mm')  // mm is same in both
      .replace(/ss/g, 'ss')  // ss is same in both
      .replace(/A/g, 'a');   // AM/PM
  }
  return format;
}

/**
 * Build a rich JSON response with multiple representations of a DateTime.
 */
export function richResponse(dt: DateTime): Record<string, unknown> {
  return {
    iso: dt.toISO(),
    unix_seconds: Math.floor(dt.toSeconds()),
    unix_ms: dt.toMillis(),
    human: dt.toFormat('cccc, d LLLL yyyy HH:mm:ss'),
    date: dt.toFormat('yyyy-MM-dd'),
    time: dt.toFormat('HH:mm:ss'),
    weekday: dt.toFormat('cccc'),
    timezone: dt.zoneName,
    offset_minutes: dt.offset,
    offset_human: dt.toFormat('ZZ'),
  };
}
