export function parseTimeString(input: string): number {
  const now = new Date();
  const normalizedInput = input.toLowerCase().trim();

  const atTimeMatch = normalizedInput.match(/^at (\d{1,2}):(\d{2})( ?(am|pm))?$/);
  if (atTimeMatch) {
    let hours = parseInt(atTimeMatch[1], 10);
    const minutes = parseInt(atTimeMatch[2], 10);
    const meridiem = atTimeMatch[4];

    if (meridiem === 'pm' && hours !== 12) {
      hours += 12;
    } else if (meridiem === 'am' && hours === 12) {
      hours = 0;
    }

    const target = new Date(now);
    target.setHours(hours, minutes, 0, 0);

    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }

    return target.getTime();
  }

  const atTimeTomorrowMatch = normalizedInput.match(/^at (\d{1,2}):(\d{2})( ?(am|pm))? tomorrow$/);
  if (atTimeTomorrowMatch) {
    let hours = parseInt(atTimeTomorrowMatch[1], 10);
    const minutes = parseInt(atTimeTomorrowMatch[2], 10);
    const meridiem = atTimeTomorrowMatch[4];

    if (meridiem === 'pm' && hours !== 12) {
      hours += 12;
    } else if (meridiem === 'am' && hours === 12) {
      hours = 0;
    }

    const target = new Date(now);
    target.setDate(target.getDate() + 1);
    target.setHours(hours, minutes, 0, 0);

    return target.getTime();
  }

  const tomorrowAtMatch = normalizedInput.match(/^tomorrow at (\d{1,2}):(\d{2})( ?(am|pm))?$/);
  if (tomorrowAtMatch) {
    let hours = parseInt(tomorrowAtMatch[1], 10);
    const minutes = parseInt(tomorrowAtMatch[2], 10);
    const meridiem = tomorrowAtMatch[4];

    if (meridiem === 'pm' && hours !== 12) {
      hours += 12;
    } else if (meridiem === 'am' && hours === 12) {
      hours = 0;
    }

    const target = new Date(now);
    target.setDate(target.getDate() + 1);
    target.setHours(hours, minutes, 0, 0);

    return target.getTime();
  }

  const inMinutesMatch = normalizedInput.match(/^in (\d+) ?(minute|minutes|min|mins)$/);
  if (inMinutesMatch) {
    const minutes = parseInt(inMinutesMatch[1], 10);
    return now.getTime() + minutes * 60 * 1000;
  }

  const inHoursMatch = normalizedInput.match(/^in (\d+) ?(hour|hours|hr|hrs)$/);
  if (inHoursMatch) {
    const hours = parseInt(inHoursMatch[1], 10);
    return now.getTime() + hours * 60 * 60 * 1000;
  }

  const inTimeMatch = normalizedInput.match(
    /^in (\d+) ?(hour|hours|hr|hrs) and (\d+) ?(minute|minutes|min|mins)$/,
  );
  if (inTimeMatch) {
    const hours = parseInt(inTimeMatch[1], 10);
    const minutes = parseInt(inTimeMatch[3], 10);
    return now.getTime() + hours * 60 * 60 * 1000 + minutes * 60 * 1000;
  }

  const isoMatch = input.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  if (isoMatch) {
    const parsed = new Date(input);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.getTime();
    }
  }

  throw new Error(
    `Could not parse time: "${input}". Supported formats:\n` +
      `- "at HH:MM" (e.g., "at 17:00", "at 5:30pm")\n` +
      `- "tomorrow at HH:MM" (e.g., "tomorrow at 9:00")\n` +
      `- "in X minutes/hours" (e.g., "in 30 minutes", "in 2 hours")\n` +
      `- "in X hours and Y minutes" (e.g., "in 1 hour and 30 minutes")\n` +
      `- ISO 8601 format (e.g., "2025-10-28T17:00:00")`,
  );
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();

  const isToday = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow = date.toDateString() === tomorrow.toDateString();

  const timeStr = date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Europe/Madrid',
  });

  if (isToday) {
    return `today at ${timeStr}`;
  }

  if (isTomorrow) {
    return `tomorrow at ${timeStr}`;
  }

  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Europe/Madrid',
  });
}
