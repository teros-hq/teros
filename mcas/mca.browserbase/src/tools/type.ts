import type { HttpToolConfig } from '@teros/mca-sdk';
import { requireSession, findElement } from '../lib/index.js';

export const type: HttpToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Type text into an editable element.',
  parameters: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Active session ID' },
      ref: { type: 'string', description: 'Element ref from snapshot or CSS selector' },
      element: { type: 'string', description: 'Human-readable element description' },
      text: { type: 'string', description: 'Text to type' },
      submit: { type: 'boolean', description: 'Press Enter after typing' },
      slowly: { type: 'boolean', description: 'Type character by character (triggers key handlers)' },
    },
    required: ['sessionId', 'ref', 'element', 'text'],
  },
  handler: async (args) => {
    const { page } = requireSession(args.sessionId as string);
    const el = await findElement(page, args.ref as string);

    if (!el) throw new Error(`Element not found: ${args.ref}`);

    if (args.slowly) {
      await el.type(args.text as string, { delay: 50 });
    } else {
      await el.fill(args.text as string);
    }

    if (args.submit) await el.press('Enter');

    return `Typed "${args.text}" into "${args.element}"`;
  },
};
