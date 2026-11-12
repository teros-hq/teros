/**
 * Natural-language schedule parsing — thin wrapper over @teros/shared.
 *
 * The parser itself lives in packages/shared/src/schedule-nl.ts (v1.4.4) so
 * the Automate window form, the backend preview handler and these agent
 * tools all translate identically. This wrapper keeps the throwing API the
 * MCA tools expect: untranslatable input throws INVALID_SCHEDULE_EXPRESSION
 * with the shared suggestion, and a cron passthrough is re-validated with
 * croner (semantics, not just shape) before it is trusted.
 */

import {
  describeScheduleCron as sharedDescribeScheduleCron,
  parseScheduleExpression as sharedParse,
  type ScheduleParseResult,
} from '@teros/shared';
import { assertValidCron } from './cron';
import { AutomateError } from './errors';

export interface ParsedSchedule {
  /** Canonical 5-field cron expression. */
  cron: string;
  /** The fragment of the input the translation was built from. */
  detectedText: string;
  /** Human-readable description of the schedule (same string describeScheduleCron produces). */
  description: string;
}

/** Parse NL (en+es) or pass a 5-field cron through. Throws INVALID_SCHEDULE_EXPRESSION when untranslatable. */
export function parseScheduleExpression(input: string): ParsedSchedule {
  const result = sharedParse(input);
  if (result.ok) {
    // Semantics check for cron passthroughs (NL-generated crons are canonical by construction).
    if (result.detectedText === result.cron || /^\d|\*/.test(result.cron)) assertValidCron(result.cron);
    return { cron: result.cron, detectedText: result.detectedText, description: result.description };
  }
  throw new AutomateError('INVALID_SCHEDULE_EXPRESSION', result.error, result.suggestion);
}

/** Re-export so existing imports keep working. */
export { sharedParse as parseScheduleExpressionResult };
export type { ScheduleParseResult };

/** Describe a 5-field cron in plain language (always-on preview). */
export function describeScheduleCron(cron: string, locale: 'en' | 'es' = 'en'): string {
  return sharedDescribeScheduleCron(cron, locale);
}
