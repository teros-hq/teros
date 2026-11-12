import { describe, expect, it } from 'bun:test';
import { describeScheduleCron, parseScheduleExpression } from '../../src/lib/schedule';
import { AutomateError } from '../../src/lib/errors';

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
    expect(r.cron).toBe(expected);
  });

  it('throws INVALID_SCHEDULE_EXPRESSION on untranslatable input', () => {
    expect(() => parseScheduleExpression('when I feel like it')).toThrow(AutomateError);
    expect(() => parseScheduleExpression('')).toThrow(AutomateError);
    expect(() => parseScheduleExpression('cada 99 minutos')).toThrow(AutomateError);
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
