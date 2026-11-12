import { DateTime } from 'luxon';
import { normalizeFormat, richResponse, type DateTimeTool } from './_shared';

export const getCurrent: DateTimeTool = {
  description:
    'Get current date and time in specified timezone. Returns a rich JSON with ISO, Unix timestamps, human-readable, weekday, etc. Optionally format with a custom format string.',
  parameters: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description: "Timezone (e.g., 'Europe/Madrid', 'America/New_York'). Defaults to local",
        default: 'local',
      },
      format: {
        type: 'string',
        description:
          "Optional output format. Accepts Luxon tokens ('yyyy-MM-dd HH:mm:ss') or Moment.js tokens ('YYYY-MM-DD HH:mm:ss'). If omitted, returns rich JSON.",
      },
    },
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true, idempotentHint: true },
  handler: async (args) => {
    const { timezone = 'local', format } = args as {
      timezone?: string;
      format?: string;
    };

    const now = timezone === 'local' ? DateTime.local() : DateTime.now().setZone(timezone);

    if (!now.isValid) {
      throw new Error(`Invalid timezone "${timezone}": ${now.invalidReason}`);
    }

    // If a custom format is requested, return just that formatted string
    if (format) {
      const luxonFormat = normalizeFormat(format);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                formatted: now.toFormat(luxonFormat),
                ...richResponse(now),
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Default: rich JSON response
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(richResponse(now), null, 2),
        },
      ],
    };
  },
};
