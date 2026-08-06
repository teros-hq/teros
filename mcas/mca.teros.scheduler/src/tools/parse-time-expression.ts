import { z } from 'zod';
import {
  formatNextRun,
  parseTimeExpression,
  previewCronOccurrences,
  resolveDefaultTimezone,
  isValidCronExpression,
  describeCronExpression,
  assertValidTimezone,
} from '../lib';
import { structured, type SchedulerTool, toToolError, validateInput } from './_shared';

const Schema = z.object({
  expression: z.string().min(1).describe('Natural language time or cron expression.'),
  timezone: z.string().optional().describe('IANA timezone (default: env MCA_DEFAULT_TIMEZONE).'),
  locale: z.enum(['en', 'es']).optional().describe('Parser locale (default: en).'),
  previewCount: z.number().int().min(1).max(20).optional().describe('Number of next occurrences (default 5, recurring only).'),
  reference: z.string().datetime().optional().describe('ISO 8601 reference timestamp (default: now).'),
});

export const parseTimeExpressionTool: SchedulerTool = {
  description:
    'Preview a time/cron expression without scheduling. Returns parsed timestamp, humanReadable, and next occurrences.',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'Natural language ("in 2 hours", "tomorrow at 9am", ISO) or cron ("0 9 * * 1-5").' },
      timezone: { type: 'string', description: 'IANA timezone (default: env MCA_DEFAULT_TIMEZONE).' },
      locale: { type: 'string', enum: ['en', 'es'], description: 'Parser locale (default: en).' },
      previewCount: { type: 'number', description: 'Next occurrences for cron (default 5, max 20).' },
      reference: { type: 'string', description: 'ISO 8601 reference timestamp (default: now).' },
    },
    required: ['expression'],
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true, idempotentHint: true },
  handler: async (args) => {
    try {
      const input = validateInput(Schema, args);
      const timezone = input.timezone ?? resolveDefaultTimezone();
      assertValidTimezone(timezone);
      const reference = input.reference ? new Date(input.reference) : new Date();
      const previewCount = input.previewCount ?? 5;
      const trimmed = input.expression.trim();

      // ISO 8601 first: croner accepts arbitrary strings (incl. ISO timestamps)
      // and would mis-classify them as kind:'cron' (P1-2 bug, audit TER-186 2026-05-06).
      // ISO must be detected BEFORE cron.
      const ISO_REGEX = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
      if (ISO_REGEX.test(trimmed)) {
        const parsed = parseTimeExpression(input.expression, {
          reference,
          timezone,
          locale: input.locale,
          allowPast: true, // preview only, never blocks
        });
        return structured({
          kind: 'iso' as const,
          expression: input.expression,
          timezone,
          confidence: parsed.confidence,
          parsed: {
            timestamp: parsed.timestamp,
            iso: parsed.date.toISOString(),
            humanReadable: formatNextRun(parsed.timestamp, timezone),
          },
        });
      }

      // 5-field cron requires whitespace separators — extra guard against
      // single-token strings croner might still accept.
      if (/\s/.test(trimmed) && isValidCronExpression(input.expression)) {
        const occurrences = previewCronOccurrences(input.expression, timezone, previewCount);
        return structured({
          kind: 'cron' as const,
          expression: input.expression,
          description: describeCronExpression(input.expression),
          timezone,
          nextOccurrences: occurrences.map((ts) => ({
            timestamp: ts,
            iso: new Date(ts).toISOString(),
            humanReadable: formatNextRun(ts, timezone),
          })),
        });
      }

      const parsed = parseTimeExpression(input.expression, {
        reference,
        timezone,
        locale: input.locale,
        allowPast: true, // preview tool — never blocks
      });
      return structured({
        kind: 'natural' as const,
        expression: input.expression,
        timezone,
        locale: parsed.locale,
        confidence: parsed.confidence,
        detectedText: parsed.detectedText,
        remainingText: parsed.remainingText,
        parsed: {
          timestamp: parsed.timestamp,
          iso: parsed.date.toISOString(),
          humanReadable: formatNextRun(parsed.timestamp, timezone),
        },
      });
    } catch (error) {
      toToolError(error);
    }
  },
};
