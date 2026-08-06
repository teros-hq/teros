import { SchedulerError } from './errors';

const VALID_TIMEZONES = new Set<string>(
  typeof (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf === 'function'
    ? (Intl as { supportedValuesOf: (key: string) => string[] }).supportedValuesOf('timeZone')
    : [],
);

export function isValidIanaTimezone(tz: string): boolean {
  if (VALID_TIMEZONES.size > 0) return VALID_TIMEZONES.has(tz);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function resolveDefaultTimezone(): string {
  const env = process.env.MCA_DEFAULT_TIMEZONE?.trim();
  if (env && isValidIanaTimezone(env)) return env;
  return 'Europe/Madrid';
}

export function assertValidTimezone(tz: string, field = 'timezone'): void {
  if (!isValidIanaTimezone(tz)) {
    throw new SchedulerError(
      'INVALID_TIMEZONE',
      `Invalid IANA timezone "${tz}" for field "${field}".`,
      'Examples: "Europe/Madrid", "America/New_York", "UTC", "Asia/Tokyo".',
    );
  }
}
