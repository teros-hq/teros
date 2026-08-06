import type { HttpToolConfig } from '@teros/mca-sdk';
import { requireSession } from '../lib/index.js';
import { mkdir } from 'fs/promises';
import { join, isAbsolute, basename, dirname } from 'path';

export const takeScreenshot: HttpToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Take a screenshot of the current page. Saved to /workspace/ on the shared volume.',
  parameters: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', description: 'Active session ID' },
      filename: {
        type: 'string',
        description: 'File name (e.g. "screenshot.png"). Defaults to screenshot-{timestamp}.png',
      },
      fullPage: { type: 'boolean', description: 'Capture full scrollable page' },
      type: {
        type: 'string',
        enum: ['png', 'jpeg'],
        description: 'Image format (default: png)',
      },
    },
    required: ['sessionId'],
  },
  handler: async (args) => {
    const { page } = requireSession(args.sessionId as string);
    const format = (args.type as 'png' | 'jpeg') || 'png';
    let filename = (args.filename as string) || `screenshot-${Date.now()}.${format}`;

    if (!isAbsolute(filename)) {
      filename = join('/workspace', filename);
    } else if (!filename.startsWith('/workspace')) {
      filename = join('/workspace', basename(filename));
    }

    await mkdir(dirname(filename), { recursive: true });
    await page.screenshot({ path: filename, type: format, fullPage: !!args.fullPage });

    // @todo nira - 2026.05.23 : migrate to backend upload path once available
    // Currently using /workspace/ shared volume path which the backend serves
    const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';
    return {
      output: `Screenshot saved to ${filename}`,
      attachments: [{
        url: filename,
        mime: mimeType,
        filename: basename(filename),
      }],
    };
  },
};
