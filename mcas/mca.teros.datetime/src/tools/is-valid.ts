import { smartParse, type DateTimeTool } from './_shared';

export const isValid: DateTimeTool = {
  description:
    'Validate a date/time string. Accepts ISO 8601, Unix timestamps, RFC 2822, SQL, and common formats. Returns whether it parses and what it parses to.',
  parameters: {
    type: 'object',
    properties: {
      datetime: {
        type: 'string',
        description: 'Date/time string to validate',
      },
      format: {
        type: 'string',
        description: 'Explicit input format (Luxon tokens) to test against (optional)',
      },
    },
    required: ['datetime'],
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true, idempotentHint: true },
  handler: async (args) => {
    const { datetime, format } = args as { datetime: string; format?: string };

    try {
      const dt = smartParse(datetime, format);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                valid: true,
                parsed_as: dt.toISO(),
                unix_seconds: Math.floor(dt.toSeconds()),
                unix_ms: dt.toMillis(),
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                valid: false,
                reason: error.message,
              },
              null,
              2,
            ),
          },
        ],
      };
    }
  },
};
