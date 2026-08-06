import { Cron } from 'croner';
import { SchedulerError } from './errors';
import { assertValidTimezone } from './timezone';

export function isValidCronExpression(expression: string): boolean {
  // El scheduler tickea cada 30s y el contrato del producto es cron de 5
  // campos (minuto hora día mes díaSemana). croner ADEMÁS acepta la forma de
  // 6 campos con SEGUNDOS (p.ej. "*/30 * * * * *" → cada 30s) y nicknames
  // (@daily…); ambos sub-minuto/no-canónicos hacen que el tick dispare la
  // tarea en CADA tick (~30s) con horas irregulares. Rechazamos != 5 campos
  // para acotar el intervalo mínimo a 1 minuto.
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  try {
    const job = new Cron(expression, { paused: true });
    job.stop();
    return true;
  } catch {
    return false;
  }
}

export function assertValidCron(expression: string): void {
  if (!isValidCronExpression(expression)) {
    throw new SchedulerError(
      'INVALID_CRON',
      `Invalid cron expression: "${expression}".`,
      'Use exactly 5 fields "minute hour day month weekday" (seconds not supported). Examples: "0 9 * * *", "*/15 * * * *", "0 10-22 * * 1-5".',
    );
  }
}

export function getNextCronRun(expression: string, timezone: string): number {
  assertValidCron(expression);
  assertValidTimezone(timezone);
  try {
    const job = new Cron(expression, { timezone, paused: true });
    const next = job.nextRun();
    job.stop();
    if (!next) {
      throw new SchedulerError(
        'INVALID_CRON',
        `Cron "${expression}" produces no future run.`,
        'Check the expression — it may be entirely in the past.',
      );
    }
    return next.getTime();
  } catch (error) {
    if (error instanceof SchedulerError) throw error;
    throw new SchedulerError(
      'INVALID_CRON',
      `Failed to compute next run for "${expression}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function previewCronOccurrences(
  expression: string,
  timezone: string,
  count = 5,
): number[] {
  assertValidCron(expression);
  assertValidTimezone(timezone);
  const job = new Cron(expression, { timezone, paused: true });
  const out: number[] = [];
  let cursor = new Date();
  for (let i = 0; i < count; i++) {
    const next = job.nextRun(cursor);
    if (!next) break;
    out.push(next.getTime());
    cursor = new Date(next.getTime() + 1);
  }
  job.stop();
  return out;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const COMMON_PATTERNS: Record<string, string> = {
  '0 9 * * *': 'Every day at 9:00',
  '0 9 * * 1-5': 'Every weekday at 9:00',
  '0 */2 * * *': 'Every 2 hours',
  '*/15 * * * *': 'Every 15 minutes',
  '0 10-22 * * 1-5': 'Every hour from 10:00 to 22:00 on weekdays',
  '0 0 * * *': 'Every day at midnight',
  '0 12 * * *': 'Every day at noon',
  '0 0 * * 0': 'Every Sunday at midnight',
  '0 0 1 * *': 'First day of every month at midnight',
};

export function describeCronExpression(expression: string): string {
  const trimmed = expression.trim();
  if (COMMON_PATTERNS[trimmed]) return COMMON_PATTERNS[trimmed];

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return trimmed;

  const [minute, hour, , , dayOfWeek] = parts;
  let description = '';

  if (minute === '*') description = 'Every minute';
  else if (minute.startsWith('*/')) description = `Every ${minute.slice(2)} minutes`;
  else description = `At minute ${minute}`;

  if (hour !== '*') {
    if (hour.includes('-')) description += ` between hours ${hour}`;
    else if (hour.startsWith('*/')) description += ` every ${hour.slice(2)} hours`;
    else description += ` at hour ${hour}`;
  }

  if (dayOfWeek !== '*') {
    if (dayOfWeek === '1-5') description += ' on weekdays';
    else if (dayOfWeek.includes(',')) {
      const days = dayOfWeek.split(',').map((d) => DAY_NAMES[parseInt(d, 10)] ?? d);
      description += ` on ${days.join(', ')}`;
    } else if (dayOfWeek.includes('-')) description += ` on days ${dayOfWeek}`;
    else description += ` on ${DAY_NAMES[parseInt(dayOfWeek, 10)] ?? dayOfWeek}`;
  }

  return description;
}
