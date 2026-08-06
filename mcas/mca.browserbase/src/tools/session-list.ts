import type { HttpToolConfig } from '@teros/mca-sdk';
import { getActiveSessions } from '../lib/index.js';

export const sessionList: HttpToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'List all active Browserbase sessions in this instance.',
  parameters: { type: 'object', properties: {} },
  handler: async () => {
    const sessions = getActiveSessions();

    if (sessions.length === 0) {
      return 'No active sessions. Use session-create to start one.';
    }

    const rows = sessions.map((s) => ({
      sessionId: s.sessionId,
      createdAt: s.createdAt,
      currentUrl: s.page.url(),
      liveViewUrl: s.liveViewUrl,
    }));

    return JSON.stringify(rows, null, 2);
  },
};
