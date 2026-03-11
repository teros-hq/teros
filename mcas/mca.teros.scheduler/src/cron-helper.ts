import { Cron } from 'croner';

/**
 * Validates a cron expression
 */
export function validateCronExpression(expression: string): boolean {
  try {
    // Try to parse the cron expression
    const job = new Cron(expression, {
      paused: true,
    });
    job.stop();
    return true;
  } catch {
    return false;
  }
}

/**
 * Gets the next run time for a cron expression
 */
export function getNextRunTime(expression: string, timezone: string = 'Europe/Madrid'): number {
  try {
    const job = new Cron(expression, {
      timezone,
      paused: true,
    });
    const next = job.nextRun();
    job.stop();

    if (!next) {
      throw new Error('Could not calculate next run time');
    }

    return next.getTime();
  } catch (error) {
    throw new Error(
      `Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Formats a cron expression into human-readable text
 */
export function describeCronExpression(expression: string): string {
  const parts = expression.split(' ');

  if (parts.length !== 5) {
    return expression;
  }

  const [minute, hour, , , dayOfWeek] = parts;

  // Simple descriptions for common patterns
  if (expression === '0 9 * * *') {
    return 'Every day at 9:00';
  }

  if (expression === '0 9 * * 1-5') {
    return 'Every weekday at 9:00';
  }

  if (expression === '0 */2 * * *') {
    return 'Every 2 hours';
  }

  if (expression === '*/15 * * * *') {
    return 'Every 15 minutes';
  }

  if (expression === '0 10-22 * * 1-5') {
    return 'Every hour from 10:00 to 22:00 on weekdays';
  }

  // Generic description
  let description = '';

  // Minute
  if (minute === '*') {
    description = 'Every minute';
  } else if (minute.startsWith('*/')) {
    description = `Every ${minute.slice(2)} minutes`;
  } else {
    description = `At minute ${minute}`;
  }

  // Hour
  if (hour !== '*') {
    if (hour.includes('-')) {
      description += ` between hours ${hour}`;
    } else if (hour.startsWith('*/')) {
      description += ` every ${hour.slice(2)} hours`;
    } else {
      description += ` at hour ${hour}`;
    }
  }

  // Day of week
  if (dayOfWeek !== '*') {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    if (dayOfWeek === '1-5') {
      description += ' on weekdays';
    } else if (dayOfWeek.includes(',')) {
      const days = dayOfWeek.split(',').map((d) => dayNames[parseInt(d, 10)]);
      description += ` on ${days.join(', ')}`;
    } else if (dayOfWeek.includes('-')) {
      description += ` on days ${dayOfWeek}`;
    } else {
      description += ` on ${dayNames[parseInt(dayOfWeek, 10)]}`;
    }
  }

  return description;
}
