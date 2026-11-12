import { richResponse, smartParse, type DateTimeTool } from './_shared';

export const convertTimezone: DateTimeTool = {
  description:
    'Convert a date/time between timezones. Accepts ISO 8601, Unix timestamps, and common formats. Returns rich JSON for both source and target.',
  parameters: {
    type: 'object',
    properties: {
      datetime: {
        type: 'string',
        description:
          'Date/time to convert. Accepts: ISO 8601, Unix timestamp (seconds or ms), RFC 2822, SQL, or common formats.',
      },
      fromTimezone: {
        type: 'string',
        description: "Source timezone (e.g., 'Europe/Madrid'). If input is a Unix timestamp, this is ignored (always UTC).",
      },
      toTimezone: {
        type: 'string',
        description: "Target timezone (e.g., 'America/New_York')",
      },
    },
    required: ['datetime', 'fromTimezone', 'toTimezone'],
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true, idempotentHint: true },
  handler: async (args) => {
    const { datetime, fromTimezone, toTimezone } = args as {
      datetime: string;
      fromTimezone: string;
      toTimezone: string;
    };

    // For Unix timestamps, zone is always UTC — fromTimezone is informational
    const isUnix = /^\d{10}$|^\d{13}$/.test(String(datetime).trim());
    const dt = smartParse(datetime);
    const sourced = isUnix ? dt : dt.setZone(fromTimezone, { keepLocalTime: !isUnix });

    if (!sourced.isValid) {
      throw new Error(`Invalid source timezone "${fromTimezone}": ${sourced.invalidReason}`);
    }

    const converted = sourced.setZone(toTimezone);
    if (!converted.isValid) {
      throw new Error(`Invalid target timezone "${toTimezone}": ${converted.invalidReason}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              original: richResponse(sourced),
              converted: richResponse(converted),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};
