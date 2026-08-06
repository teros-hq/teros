import type { ToolConfig } from '@teros/mca-sdk';
import fs from 'fs/promises';
import { wahaFetch } from '../lib/api';

export const sendDocument: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Send a document or file (PDF, DOCX, XLSX, etc.) to a WhatsApp chat from a public URL or a local /workspace/ path.',
  parameters: {
    type: 'object',
    properties: {
      session: {
        type: 'string',
        description: 'Session name (default: "default")',
      },
      chatId: {
        type: 'string',
        description: 'Recipient chat ID (e.g. 34612345678@c.us for individuals, 120363XXXXXX@g.us for groups)',
      },
      url: {
        type: 'string',
        description: 'Public HTTPS URL of the file to send, or a local path starting with /workspace/ (e.g. "/workspace/report.pdf")',
      },
      filename: {
        type: 'string',
        description: 'File name shown to the recipient (e.g. "report.pdf")',
      },
      mimetype: {
        type: 'string',
        description: 'MIME type of the file (e.g. "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"). Defaults to "application/octet-stream".',
      },
      caption: {
        type: 'string',
        description: 'Optional caption text shown below the file',
      },
    },
    required: ['chatId', 'url', 'filename'],
  },
  handler: async (args) => {
    const {
      session = 'default',
      chatId,
      url,
      filename,
      mimetype = 'application/octet-stream',
      caption = '',
    } = args as {
      session?: string;
      chatId: string;
      url: string;
      filename: string;
      mimetype?: string;
      caption?: string;
    };

    let filePayload: { url: string } | { data: string; filename: string; mimetype: string };

    if (url.startsWith('/workspace/') || (url.startsWith('/') && !url.startsWith('//'))) {
      // Local file — read and encode as base64
      const buffer = await fs.readFile(url);
      const base64 = buffer.toString('base64');
      filePayload = { data: base64, filename, mimetype };
    } else {
      // Remote URL — pass directly
      filePayload = { url };
    }

    const res = await wahaFetch('/sendFile', {
      method: 'POST',
      body: JSON.stringify({
        session,
        chatId,
        file: filePayload,
        caption,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { success: false, status: res.status, error: `WAHA returned HTTP ${res.status}`, detail: err };
    }
    return await res.json();
  },
};
