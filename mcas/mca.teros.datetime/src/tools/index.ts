import type { ToolConfig } from '@teros/mca-sdk';
import { add } from './add';
import { convertTimezone } from './convert-timezone';
import { diff } from './diff';
import { formatTool } from './format';
import { getCurrent } from './get-current';
import { isValid } from './is-valid';
import { parseTool } from './parse';
import { subtract } from './subtract';

export type DateTimeTool<TArgs = Record<string, unknown>, TResult = unknown> = ToolConfig<
  TArgs,
  TResult
>;

/**
 * Ordered registry of the 8 datetime tools — the single source of truth for
 * both server registration (src/index.ts) and the test dispatcher
 * (test/unit/_dispatcher.ts). Adding a tool here is all it takes.
 */
export const TOOL_REGISTRY: Array<{ name: string; tool: DateTimeTool }> = [
  { name: 'get-current', tool: getCurrent },
  { name: 'format', tool: formatTool },
  { name: 'parse', tool: parseTool },
  { name: 'convert-timezone', tool: convertTimezone },
  { name: 'add', tool: add },
  { name: 'subtract', tool: subtract },
  { name: 'diff', tool: diff },
  { name: 'is-valid', tool: isValid },
];

export {
  add,
  convertTimezone,
  diff,
  formatTool,
  getCurrent,
  isValid,
  parseTool,
  subtract,
};
