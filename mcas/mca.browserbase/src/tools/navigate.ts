import type { HttpToolConfig } from '@teros/mca-sdk';
import { requireSession } from '../lib/index.js';

export const navigate: HttpToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Navigate the browser to a URL.',
  parameters: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Active session ID' },
      url: { type: 'string', description: 'URL to navigate to' },
    },
    required: ['sessionId', 'url'],
  },
  handler: async (args) => {
    const { page } = requireSession(args.sessionId as string);
    await page.goto(args.url as string, { waitUntil: 'domcontentloaded' });
    return `Navigated to ${args.url}\nTitle: ${await page.title()}`;
  },
};
