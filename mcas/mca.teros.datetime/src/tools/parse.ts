import { richResponse, smartParse, type DateTimeTool } from './_shared';

export const parseTool: DateTimeTool = {
  description:
    'Parse a date/time string into structured data. Accepts ISO 8601, Unix timestamps (seconds or ms), RFC 2822, SQL, and common formats. Returns rich JSON with all representations.',
  parameters: {
    type: 'object',
    properties: {
      datetime: {
        type: 'string',
        description:
          'Date/time to parse. Accepts: ISO 8601, Unix timestamp (seconds or ms), RFC 2822, SQL, or common formats.',
      },
      format: {
        type: 'string',
        description: 'Explicit input format (Luxon tokens) if auto-detection fails (optional)',
      },
      timezone: {
        type: 'string',
        description: "Target timezone for output (e.g., 'Europe/Madrid'). Defaults to keeping the input's timezone.",
      },
    },
    required: ['datetime'],
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true, idempotentHint: true },
  handler: async (args) => {
    const { datetime, format, timezone } = args as {
      datetime: string;
      format?: string;
      timezone?: string;
    };

    let dt = smartParse(datetime, format);

    if (timezone) {
      dt = dt.setZone(timezone);
      if (!dt.isValid) {
        throw new Error(`Invalid timezone "${timezone}": ${dt.invalidReason}`);
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              valid: true,
              ...richResponse(dt),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};
