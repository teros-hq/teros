import type { HttpToolConfig } from '@teros/mca-sdk';
import { requireSession } from '../lib/index.js';

export const navigateBack: HttpToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Go back to the previous page.',
  parameters: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Active session ID' },
    },
    required: ['sessionId'],
  },
  handler: async (args) => {
    const { page } = requireSession(args.sessionId as string);
    await page.goBack();
    return `Navigated back to ${page.url()}`;
  },
};
