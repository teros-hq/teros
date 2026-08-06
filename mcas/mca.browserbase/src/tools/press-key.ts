import type { HttpToolConfig } from '@teros/mca-sdk';
import { requireSession } from '../lib/index.js';

export const pressKey: HttpToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Press a keyboard key.',
  parameters: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Active session ID' },
      key: {
        type: 'string',
        description: 'Key name or character, e.g. "Enter", "ArrowDown", "a"',
      },
    },
    required: ['sessionId', 'key'],
  },
  handler: async (args) => {
    const { page } = requireSession(args.sessionId as string);
    await page.keyboard.press(args.key as string);
    return `Pressed key: ${args.key}`;
  },
};
