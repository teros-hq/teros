import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import {
  ensureAuthenticated,
  initializeGoogleClients,
  saveToDownloads,
  withAuthRetry,
} from '../lib';

const EXPORT_FORMATS: Record<string, string> = {
  'application/vnd.google-apps.document': 'application/pdf',
  'application/vnd.google-apps.spreadsheet':
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.google-apps.presentation': 'application/pdf',
  'application/vnd.google-apps.drawing': 'image/png',
};

const EXTENSION_MAP: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'image/png': 'png',
};

export const downloadFile: ToolConfig = {
  description: 'Download a file from Google Drive.',
  parameters: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        description: 'The ID of the file to download',
      },
      outputPath: {
        type: 'string',
        description: 'Optional: Local path to save the file (default: current directory)',
      },
    },
    required: ['fileId'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { fileId, outputPath } = args as { fileId: string; outputPath?: string };

    return withAuthRetry(
      context,
      async () => {
        // Get file info
        const fileInfo = await clients.drive.files.get({
          fileId,
          fields: 'id, name, mimeType, size',
        });

        const mimeType = fileInfo.data.mimeType || '';
        const fileName = fileInfo.data.name || 'download';

        if (mimeType === 'application/vnd.google-apps.folder') {
          throw new Error('Cannot download folders. Use list-files to browse folder contents.');
        }

        let buffer: Buffer;
        let finalFileName = fileName;

        // Handle Google Workspace files (need export)
        if (mimeType.startsWith('application/vnd.google-apps')) {
          const exportFormat = EXPORT_FORMATS[mimeType] || 'application/pdf';
          const extension = EXTENSION_MAP[exportFormat] || 'pdf';

          const response = await clients.drive.files.export(
            { fileId, mimeType: exportFormat },
            { responseType: 'arraybuffer' },
          );

          buffer = Buffer.from(response.data as ArrayBuffer);
          finalFileName = `${fileName}.${extension}`;
        } else {
          // Regular file download
          const response = await clients.drive.files.get(
            { fileId, alt: 'media' },
            { responseType: 'arraybuffer' },
          );

          buffer = Buffer.from(response.data as ArrayBuffer);
        }

        const savedPath = await saveToDownloads(buffer, finalFileName, outputPath);

        return {
          success: true,
          filename: finalFileName,
          path: savedPath,
          size: buffer.length,
        };
      },
      'download-file',
    );
  },
};
