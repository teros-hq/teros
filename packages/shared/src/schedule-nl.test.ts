/**
 * schedule-nl tests — the shared NL→cron parser (result-object API).
 * Ported from the automate MCA's schedule.test.ts (v1.4.4); the same cases
 * must keep passing wherever the parser lives.
 */

import { describe, expect, it } from 'bun:test';
import { cronToScheduleText, describeScheduleCron, isFiveFieldCron, parseScheduleExpression } from './schedule-nl';

describe('parseScheduleExpression (natural language → cron)', () => {
  it.each([
    // Spanish
    ['cada lunes a las 9', '0 9 * * 1'],
    ['Cada lunes a las 9', '0 9 * * 1'],
    ['lunes a las 9:30', '30 9 * * 1'],
    ['lunes, miércoles y viernes a las 9', '0 9 * * 1,3,5'],
    ['weekdays a las 8', '0 8 * * 1-5'],
    ['días laborables a las 8', '0 8 * * 1-5'],
    ['todos los días a las 9', '0 9 * * *'],
    ['cada día a las 9', '0 9 * * *'],
    ['cada 2 horas', '0 */2 * * *'],
    ['cada 15 minutos', '*/15 * * * *'],
    ['el primer día de mes', '0 0 1 * *'],
    ['primer día del mes a las 9', '0 9 1 * *'],
    ['día 15 a las 10', '0 10 15 * *'],
    ['a las 9', '0 9 * * *'],
    ['a las 21:00', '0 21 * * *'],
    ['sábado y domingo a las 10', '0 10 * * 0,6'],
    // English
    ['every monday at 9am', '0 9 * * 1'],
    ['mondays at 9', '0 9 * * 1'],
    ['every day at 9', '0 9 * * *'],
    ['weekdays at 8am', '0 8 * * 1-5'],
    ['every 2 hours', '0 */2 * * *'],
    ['every 15 minutes', '*/15 * * * *'],
    ['first day of every month', '0 0 1 * *'],
    ['on the 15th at 10', '0 10 15 * *'],
    ['at 9', '0 9 * * *'],
    ['saturday and sunday at 10', '0 10 * * 0,6'],
    ['tuesday at 9pm', '0 21 * * 2'],
    // Cron passthrough (advanced mode)
    ['0 9 * * 1-5', '0 9 * * 1-5'],
    ['*/30 * * * *', '*/30 * * * *'],
  ])('%p → %p', (input, expected) => {
    const r = parseScheduleExpression(input);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.cron).toBe(expected);
  });

  it('returns ok:false with a suggestion on untranslatable input', () => {
    expect(parseScheduleExpression('when I feel like it')).toMatchObject({ ok: false });
    expect(parseScheduleExpression('')).toMatchObject({ ok: false });
    expect(parseScheduleExpression('cada 99 minutos')).toMatchObject({ ok: false });
    const r = parseScheduleExpression('when I feel like it');
    if (!r.ok) expect(r.suggestion).toContain('cada lunes a las 9');
  });
});

describe('isFiveFieldCron (structural check used by the passthrough)', () => {
  it('accepts 5-field shapes and rejects the rest', () => {
    expect(isFiveFieldCron('0 9 * * 1-5')).toBe(true);
    expect(isFiveFieldCron('*/15 * * * *')).toBe(true);
    expect(isFiveFieldCron('0 0 1 * *')).toBe(true);
    expect(isFiveFieldCron('30 8-18/2 * * 1,3,5')).toBe(true);
    expect(isFiveFieldCron('0 9 * * * *')).toBe(false); // 6 fields = seconds, unsupported
    expect(isFiveFieldCron('@daily')).toBe(false);
    expect(isFiveFieldCron('cada lunes')).toBe(false);
    expect(isFiveFieldCron('')).toBe(false);
    // Per-field bounds (position-aware)
    expect(isFiveFieldCron('0 25 * * *')).toBe(false); // hour 25
    expect(isFiveFieldCron('61 * * * *')).toBe(false); // minute 61
    expect(isFiveFieldCron('0 9 0 * *')).toBe(false); // day-of-month 0
    expect(isFiveFieldCron('0 9 * * 8')).toBe(false); // weekday 8
    expect(isFiveFieldCron('0 9 * * 7')).toBe(true); // weekday 7 = Sunday (croner tolerance)
    expect(isFiveFieldCron('0 22-6 * * *')).toBe(false); // inverted range
    expect(isFiveFieldCron('*/0 * * * *')).toBe(false); // step 0
  });
});

describe('cronToScheduleText (cron → editable NL field value)', () => {
  it('strips the prefix and round-trips back to the same cron', () => {
    // Round-trip: cron → NL text → parse → same cron. This is what the form's
    // auto-fill relies on.
    const cases: Array<[string, string]> = [
      ['0 9 * * 1', 'lunes a las 09:00'],
      ['0 9 * * 1,3,5', 'lunes, miércoles y viernes a las 09:00'],
      ['30 8 * * *', 'todos los días a las 08:30'],
      ['0 8 * * 1-5', 'días laborables (lunes a viernes) a las 08:00'],
      ['0 10 * * 2-7', 'de martes a domingo a las 10:00'],
    ];
    for (const [cron, expectedText] of cases) {
      const text = cronToScheduleText(cron, 'es');
      expect(text).toBe(expectedText);
      const reparsed = parseScheduleExpression(text);
      expect(reparsed.ok).toBe(true);
      if (reparsed.ok) expect(reparsed.cron).toBe(cron);
    }
  });

  it('describes day ranges as ranges and collapses the Sunday alias', () => {
    expect(describeScheduleCron('0 10 * * 2-7', 'es')).toBe('Se ejecutará: de martes a domingo a las 10:00');
    expect(describeScheduleCron('0 10 * * 2-7')).toBe('Runs: from Tuesday to Sunday at 10:00');
    expect(describeScheduleCron('0 9 * * 0,7', 'es')).toBe('Se ejecutará: domingo a las 09:00');
  });

  it('keeps the full description for crons with no round-tripping NL shape', () => {
    // Hour ranges have no NL form that re-parses to the same cron; the caller
    // falls back to the cron itself as the field value (parses as passthrough).
    expect(cronToScheduleText('0 10-22 * * 1-5', 'es')).toBe('días laborables (lunes a viernes) de 10:00 a 22:00');
  });
});

describe('describeScheduleCron (always-on human preview)', () => {
  it('describes day lists Monday-first with locale', () => {
    expect(describeScheduleCron('0 9 * * 1,3,5')).toBe('Runs: Monday, Wednesday and Friday at 09:00');
    expect(describeScheduleCron('0 9 * * 1,3,5', 'es')).toBe('Se ejecutará: lunes, miércoles y viernes a las 09:00');
  });

  it('describes common patterns', () => {
    expect(describeScheduleCron('0 9 * * 1-5', 'es')).toBe('Se ejecutará: días laborables (lunes a viernes) a las 09:00');
    expect(describeScheduleCron('0 9 * * *', 'es')).toBe('Se ejecutará: todos los días a las 09:00');
    expect(describeScheduleCron('0 */2 * * *', 'es')).toBe('Se ejecutará: todos los días cada 2 horas');
    expect(describeScheduleCron('*/15 * * * *', 'es')).toBe('cada 15 minutos');
    expect(describeScheduleCron('0 0 1 * *', 'es')).toBe('Se ejecutará: el día 1 de cada mes a las 00:00');
    expect(describeScheduleCron('30 8 * * *')).toBe('Runs: every day at 08:30');
    expect(describeScheduleCron('0 10-22 * * 1-5')).toBe('Runs: weekdays (Monday to Friday) from 10:00 to 22:00');
  });
});
