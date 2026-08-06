import type { HttpToolConfig } from '@teros/mca-sdk';
import { requireSession } from '../lib/index.js';

export const getContent: HttpToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get the current page HTML or plain text content.',
  parameters: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Active session ID' },
      format: {
        type: 'string',
        enum: ['html', 'text'],
        description: 'Return full HTML or plain text (default: text)',
      },
    },
    required: ['sessionId'],
  },
  handler: async (args) => {
    const { page } = requireSession(args.sessionId as string);
    const format = (args.format as string) || 'text';

    if (format === 'html') {
      return page.content();
    }

    // Plain text: extract via evaluate
    return page.evaluate(() => document.body.innerText);
  },
};
