import { richResponse, smartParse, type DateTimeTool } from './_shared';

export const diff: DateTimeTool = {
  description:
    'Calculate difference between two dates. Accepts ISO 8601, Unix timestamps, and common formats.',
  parameters: {
    type: 'object',
    properties: {
      start: {
        type: 'string',
        description: 'Start date/time. Accepts: ISO 8601, Unix timestamp, RFC 2822, SQL, or common formats.',
      },
      end: {
        type: 'string',
        description: 'End date/time. Accepts: ISO 8601, Unix timestamp, RFC 2822, SQL, or common formats.',
      },
      unit: {
        type: 'string',
        enum: ['years', 'months', 'weeks', 'days', 'hours', 'minutes', 'seconds', 'milliseconds'],
        description: 'Unit for the result (default: milliseconds)',
      },
    },
    required: ['start', 'end'],
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true, idempotentHint: true },
  handler: async (args) => {
    const { start, end, unit = 'milliseconds' } = args as {
      start: string;
      end: string;
      unit?: string;
    };

    const startDt = smartParse(start);
    const endDt = smartParse(end);

    const difference = endDt.diff(startDt, unit as any);
    const value = difference.as(unit as any);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              start: richResponse(startDt),
              end: richResponse(endDt),
              difference: {
                value,
                unit,
                human: value === 1 ? `${value} ${unit.replace(/s$/, '')}` : `${value} ${unit}`,
              },
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};
