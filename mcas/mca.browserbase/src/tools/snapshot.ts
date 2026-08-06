import type { HttpToolConfig } from '@teros/mca-sdk';
import { requireSession, getAccessibilitySnapshot } from '../lib/index.js';

export const snapshot: HttpToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Capture an accessibility snapshot of the current page. Returns the page structure with element refs for interaction.',
  parameters: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Active session ID' },
    },
    required: ['sessionId'],
  },
  handler: async (args) => {
    const { page } = requireSession(args.sessionId as string);
    return getAccessibilitySnapshot(page);
  },
};
