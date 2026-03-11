#!/usr/bin/env npx tsx

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { DateTime } from 'luxon';

const server = new Server(
  {
    name: 'mca.teros.datetime',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'get-current',
        description: 'Get current date and time in specified timezone',
        inputSchema: {
          type: 'object',
          properties: {
            timezone: {
              type: 'string',
              description:
                "Timezone (e.g., 'Europe/Madrid', 'America/New_York'). Defaults to local",
              default: 'local',
            },
            format: {
              type: 'string',
              description: "Output format (e.g., 'yyyy-MM-dd HH:mm:ss'). Defaults to ISO",
              default: 'iso',
            },
          },
        },
      },
      {
        name: 'format',
        description: 'Format a date/time string',
        inputSchema: {
          type: 'object',
          properties: {
            datetime: {
              type: 'string',
              description: 'Date/time string to format',
            },
            format: {
              type: 'string',
              description: "Output format (e.g., 'yyyy-MM-dd', 'HH:mm:ss', 'MMMM d, yyyy')",
            },
            inputFormat: {
              type: 'string',
              description: 'Input format if datetime is not ISO (optional)',
            },
          },
          required: ['datetime', 'format'],
        },
      },
      {
        name: 'parse',
        description: 'Parse a date/time string',
        inputSchema: {
          type: 'object',
          properties: {
            datetime: {
              type: 'string',
              description: 'Date/time string to parse',
            },
            format: {
              type: 'string',
              description: "Expected format (e.g., 'yyyy-MM-dd HH:mm:ss'). Optional if ISO",
            },
          },
          required: ['datetime'],
        },
      },
      {
        name: 'convert-timezone',
        description: 'Convert time between timezones',
        inputSchema: {
          type: 'object',
          properties: {
            datetime: {
              type: 'string',
              description: 'Date/time string',
            },
            fromTimezone: {
              type: 'string',
              description: "Source timezone (e.g., 'Europe/Madrid')",
            },
            toTimezone: {
              type: 'string',
              description: "Target timezone (e.g., 'America/New_York')",
            },
          },
          required: ['datetime', 'fromTimezone', 'toTimezone'],
        },
      },
      {
        name: 'add',
        description: 'Add duration to a date/time',
        inputSchema: {
          type: 'object',
          properties: {
            datetime: {
              type: 'string',
              description: 'Base date/time string',
            },
            duration: {
              type: 'object',
              description: 'Duration to add (e.g., {days: 5, hours: 2})',
              properties: {
                years: { type: 'number' },
                months: { type: 'number' },
                days: { type: 'number' },
                hours: { type: 'number' },
                minutes: { type: 'number' },
                seconds: { type: 'number' },
              },
            },
          },
          required: ['datetime', 'duration'],
        },
      },
      {
        name: 'subtract',
        description: 'Subtract duration from a date/time',
        inputSchema: {
          type: 'object',
          properties: {
            datetime: {
              type: 'string',
              description: 'Base date/time string',
            },
            duration: {
              type: 'object',
              description: 'Duration to subtract (e.g., {days: 5, hours: 2})',
              properties: {
                years: { type: 'number' },
                months: { type: 'number' },
                days: { type: 'number' },
                hours: { type: 'number' },
                minutes: { type: 'number' },
                seconds: { type: 'number' },
              },
            },
          },
          required: ['datetime', 'duration'],
        },
      },
      {
        name: 'diff',
        description: 'Calculate difference between two dates',
        inputSchema: {
          type: 'object',
          properties: {
            start: {
              type: 'string',
              description: 'Start date/time',
            },
            end: {
              type: 'string',
              description: 'End date/time',
            },
            unit: {
              type: 'string',
              enum: ['years', 'months', 'days', 'hours', 'minutes', 'seconds', 'milliseconds'],
              description: 'Unit for the result (default: milliseconds)',
            },
          },
          required: ['start', 'end'],
        },
      },
      {
        name: 'is-valid',
        description: 'Validate a date/time string',
        inputSchema: {
          type: 'object',
          properties: {
            datetime: {
              type: 'string',
              description: 'Date/time string to validate',
            },
            format: {
              type: 'string',
              description: 'Expected format (optional if ISO)',
            },
          },
          required: ['datetime'],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  console.error(`[MCA DateTime] Tool called: ${name}`);
  console.error(`[MCA DateTime] Arguments:`, JSON.stringify(args, null, 2));

  try {
    if (name === 'get-current') {
      const { timezone = 'local', format = 'iso' } = args as {
        timezone?: string;
        format?: string;
      };

      const now = timezone === 'local' ? DateTime.local() : DateTime.now().setZone(timezone);

      const result = format === 'iso' ? now.toISO() : now.toFormat(format);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                datetime: result,
                timezone: now.zoneName,
                offset: now.offset,
                timestamp: now.toMillis(),
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === 'format') {
      const { datetime, format, inputFormat } = args as {
        datetime: string;
        format: string;
        inputFormat?: string;
      };

      let dt: DateTime;
      if (inputFormat) {
        dt = DateTime.fromFormat(datetime, inputFormat);
      } else {
        dt = DateTime.fromISO(datetime);
      }

      if (!dt.isValid) {
        throw new Error(`Invalid datetime: ${dt.invalidReason}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: dt.toFormat(format),
          },
        ],
      };
    }

    if (name === 'parse') {
      const { datetime, format } = args as {
        datetime: string;
        format?: string;
      };

      const dt = format ? DateTime.fromFormat(datetime, format) : DateTime.fromISO(datetime);

      if (!dt.isValid) {
        throw new Error(`Invalid datetime: ${dt.invalidReason}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                iso: dt.toISO(),
                timestamp: dt.toMillis(),
                timezone: dt.zoneName,
                valid: true,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === 'convert-timezone') {
      const { datetime, fromTimezone, toTimezone } = args as {
        datetime: string;
        fromTimezone: string;
        toTimezone: string;
      };

      const dt = DateTime.fromISO(datetime, { zone: fromTimezone });
      if (!dt.isValid) {
        throw new Error(`Invalid datetime: ${dt.invalidReason}`);
      }

      const converted = dt.setZone(toTimezone);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                original: {
                  datetime: dt.toISO(),
                  timezone: fromTimezone,
                  offset: dt.offset,
                },
                converted: {
                  datetime: converted.toISO(),
                  timezone: toTimezone,
                  offset: converted.offset,
                },
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === 'add') {
      const { datetime, duration } = args as {
        datetime: string;
        duration: any;
      };

      const dt = DateTime.fromISO(datetime);
      if (!dt.isValid) {
        throw new Error(`Invalid datetime: ${dt.invalidReason}`);
      }

      const result = dt.plus(duration);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                original: dt.toISO(),
                result: result.toISO(),
                duration,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === 'subtract') {
      const { datetime, duration } = args as {
        datetime: string;
        duration: any;
      };

      const dt = DateTime.fromISO(datetime);
      if (!dt.isValid) {
        throw new Error(`Invalid datetime: ${dt.invalidReason}`);
      }

      const result = dt.minus(duration);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                original: dt.toISO(),
                result: result.toISO(),
                duration,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === 'diff') {
      const {
        start,
        end,
        unit = 'milliseconds',
      } = args as {
        start: string;
        end: string;
        unit?: string;
      };

      const startDt = DateTime.fromISO(start);
      const endDt = DateTime.fromISO(end);

      if (!startDt.isValid) {
        throw new Error(`Invalid start datetime: ${startDt.invalidReason}`);
      }
      if (!endDt.isValid) {
        throw new Error(`Invalid end datetime: ${endDt.invalidReason}`);
      }

      const diff = endDt.diff(startDt, unit as any);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                start: startDt.toISO(),
                end: endDt.toISO(),
                difference: diff.toObject(),
                unit,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === 'is-valid') {
      const { datetime, format } = args as {
        datetime: string;
        format?: string;
      };

      const dt = format ? DateTime.fromFormat(datetime, format) : DateTime.fromISO(datetime);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                valid: dt.isValid,
                reason: dt.invalidReason,
                explanation: dt.invalidExplanation,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Teros DateTime MCA server running');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
