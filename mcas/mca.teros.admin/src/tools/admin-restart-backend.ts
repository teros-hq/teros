import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';

/**
 * ⚠️  HTTP EXCEPTION: This tool uses HTTP fetch instead of WebSocket.
 *
 * Reason: POST /admin/restart causes the backend to restart. If the WS drops
 * during the process (which is likely), the WebSocket channel would be unusable
 * to send the request. HTTP is the only reliable fallback channel in this case.
 *
 * The POST /admin/restart endpoint is kept in admin-routes.ts as the sole
 * survivor of the HTTP→WS migration.
 */
export const adminRestartBackend: ToolConfig = {
  description:
    'Restart the Teros backend server. This will gracefully shutdown all MCA processes and restart the backend. Use with caution - this will temporarily interrupt service.',
  parameters: {
    type: 'object',
    properties: {
      confirm: {
        type: 'boolean',
        description: 'Confirmation flag - must be true to proceed with restart',
      },
    },
    required: ['confirm'],
  },
  handler: async (args, context) => {
    const confirm = args.confirm as boolean;

    if (!confirm) {
      throw new Error(
        "Restart not confirmed. You must set 'confirm: true' to restart the backend.",
      );
    }

    // HTTP fallback — the only admin route that remains as HTTP
    const secrets = await context.getSystemSecrets();
    const apiUrl = secrets?.ADMIN_API_URL || secrets?.admin_api_url;
    const apiKey = secrets?.ADMIN_API_KEY || secrets?.admin_api_key;

    if (!apiUrl || !apiKey) {
      throw new Error(
        'ADMIN_API_URL and ADMIN_API_KEY are required for restart (HTTP fallback). ' +
        'Configure them in system secrets.',
      );
    }

    const response = await fetch(`${apiUrl}/admin/restart`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    });

    const data = await response.json() as Record<string, unknown>;

    if (!response.ok) {
      throw new Error(
        (data.message as string) || (data.error as string) || `HTTP ${response.status}`,
      );
    }

    return {
      success: true,
      message: 'Backend restart initiated',
      ...data,
    };
  },
};
