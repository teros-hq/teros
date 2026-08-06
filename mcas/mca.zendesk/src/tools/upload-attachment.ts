import type { ToolConfig } from '@teros/mca-sdk';
import { zendeskRequest, getBaseUrl, encodeAuth } from '../lib';

export const uploadAttachment: ToolConfig = {
  description:
    'Upload a file attachment to Zendesk for use in ticket comments. Returns upload token. Params: filePath, fileName?.',
  parameters: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Path to the file to upload.',
      },
      fileName: {
        type: 'string',
        description: 'Desired filename for the attachment. Defaults to basename of filePath.',
      },
    },
    required: ['filePath'],
  },
  annotations: { readOnlyHint: false, version: '1.1.0', stability: 'stable' },
  handler: async (args, context) => {
    const { filePath, fileName } = args as {
      filePath: string;
      fileName?: string;
    };

    // Read file as base64
    const fs = await import('fs');
    const path = await import('path');
    const resolvedPath = path.resolve(filePath);
    const name = fileName || path.basename(resolvedPath);
    const fileBuffer = fs.readFileSync(resolvedPath);

    const userSecrets = (await context.getUserSecrets()) as {
      SUBDOMAIN?: string;
      EMAIL?: string;
      API_TOKEN?: string;
    };
    const subdomain = userSecrets.SUBDOMAIN;
    const email = userSecrets.EMAIL;
    const apiToken = userSecrets.API_TOKEN;

    if (!subdomain || !email || !apiToken) {
      throw new Error('Zendesk credentials not configured.');
    }

    // Build upload URL
    const uploadUrl = new URL(`${getBaseUrl(subdomain)}/uploads.json`);
    uploadUrl.searchParams.set('filename', name);

    const response = await fetch(uploadUrl.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Basic ${encodeAuth(email, apiToken)}`,
        'Content-Type': 'application/binary',
      },
      body: fileBuffer,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`Zendesk upload error ${response.status}: ${errorText}`);
    }

    const result = (await response.json()) as any;
    return {
      token: result.upload?.token,
      attachment: result.upload?.attachment,
      expiresAt: result.upload?.expires_at,
    };
  },
};
