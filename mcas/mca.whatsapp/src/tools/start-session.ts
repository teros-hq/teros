import type { ToolConfig } from '@teros/mca-sdk';
import { wahaFetch } from '../lib/api';

export const startSession: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Start a WhatsApp session. Creates it if it does not exist. If the session is in FAILED state, it will be stopped and restarted automatically. After starting, use request-pairing-code to link the device — authentication is always done with a pairing code (QR is not supported).',
  parameters: {
    type: 'object',
    properties: {
      session: {
        type: 'string',
        description: 'Session name (default: "default")',
      },
    },
  },
  handler: async (args) => {
    const { session = 'default' } = args as { session?: string };

    // 1. Check if session already exists
    const statusRes = await wahaFetch(`/sessions/${session}`);

    if (statusRes.status === 404) {
      // Session does not exist → create it with GOWS storage config
      const createRes = await wahaFetch('/sessions', {
        method: 'POST',
        body: JSON.stringify({
          name: session,
          config: {
            gows: {
              storage: {
                messages: true,
                groups: true,
                chats: true,
                labels: true,
              },
            },
          },
        }),
      });
      if (!createRes.ok) {
        const err = await createRes.json().catch(() => ({}));
        return { success: false, error: `Failed to create session: ${createRes.status}`, detail: err };
      }
    } else if (statusRes.ok) {
      // Session exists — check if FAILED and recover
      const statusData = await statusRes.json();
      if (statusData.status === 'FAILED') {
        // Stop first, then fall through to start
        await wahaFetch(`/sessions/${session}/stop`, { method: 'POST' });
      }
    }

    // 2. Start the session
    const startRes = await wahaFetch(`/sessions/${session}/start`, { method: 'POST' });
    if (!startRes.ok) {
      const err = await startRes.json().catch(() => ({}));
      return { success: false, error: `Failed to start session: ${startRes.status}`, detail: err };
    }
    const startData = await startRes.json().catch(() => ({}));
    return { success: true, session, ...startData };
  },
};
