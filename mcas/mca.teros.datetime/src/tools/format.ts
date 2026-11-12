import { normalizeFormat, smartParse, type DateTimeTool } from './_shared';

export const formatTool: DateTimeTool = {
  description:
    'Format a date/time string. Accepts ISO 8601, Unix timestamps (seconds or ms), and common formats. Supports both Luxon and Moment.js format tokens.',
  parameters: {
    type: 'object',
    properties: {
      datetime: {
        type: 'string',
        description:
          'Date/time to format. Accepts: ISO 8601, Unix timestamp (seconds or ms, as string or number), RFC 2822, SQL, or common formats.',
      },
      format: {
        type: 'string',
        description:
          "Output format. Luxon tokens ('yyyy-MM-dd', 'HH:mm:ss', 'cccc, d LLLL yyyy') or Moment.js tokens ('YYYY-MM-DD', 'dddd, D MMMM YYYY').",
      },
      inputFormat: {
        type: 'string',
        description: 'Explicit input format (Luxon tokens) if auto-detection fails (optional)',
      },
      timezone: {
        type: 'string',
        description: "Target timezone for output (e.g., 'Europe/Madrid'). Defaults to keeping the input's timezone.",
      },
    },
    required: ['datetime', 'format'],
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true, idempotentHint: true },
  handler: async (args) => {
    const { datetime, format, inputFormat, timezone } = args as {
      datetime: string;
      format: string;
      inputFormat?: string;
      timezone?: string;
    };

    let dt = smartParse(datetime, inputFormat);

    if (timezone) {
      dt = dt.setZone(timezone);
      if (!dt.isValid) {
        throw new Error(`Invalid timezone "${timezone}": ${dt.invalidReason}`);
      }
    }

    const luxonFormat = normalizeFormat(format);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              formatted: dt.toFormat(luxonFormat),
              iso: dt.toISO(),
              unix_seconds: Math.floor(dt.toSeconds()),
              unix_ms: dt.toMillis(),
              timezone: dt.zoneName,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};
