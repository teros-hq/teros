import { richResponse, smartParse, type DateTimeTool } from './_shared';

export const add: DateTimeTool = {
  description:
    'Add duration to a date/time. Accepts ISO 8601, Unix timestamps, and common formats.',
  parameters: {
    type: 'object',
    properties: {
      datetime: {
        type: 'string',
        description: 'Base date/time. Accepts: ISO 8601, Unix timestamp (seconds or ms), RFC 2822, SQL, or common formats.',
      },
      duration: {
        type: 'object',
        description: 'Duration to add (e.g., {days: 5, hours: 2})',
        properties: {
          years: { type: 'number' },
          months: { type: 'number' },
          weeks: { type: 'number' },
          days: { type: 'number' },
          hours: { type: 'number' },
          minutes: { type: 'number' },
          seconds: { type: 'number' },
        },
      },
      timezone: {
        type: 'string',
        description: "Timezone for output (e.g., 'Europe/Madrid'). Defaults to keeping the input's timezone.",
      },
    },
    required: ['datetime', 'duration'],
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true, idempotentHint: true },
  handler: async (args) => {
    const { datetime, duration, timezone } = args as {
      datetime: string;
      duration: any;
      timezone?: string;
    };

    let dt = smartParse(datetime);
    let result = dt.plus(duration);

    if (timezone) {
      result = result.setZone(timezone);
      if (!result.isValid) {
        throw new Error(`Invalid timezone "${timezone}": ${result.invalidReason}`);
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              original: richResponse(dt),
              result: richResponse(result),
              duration,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};
