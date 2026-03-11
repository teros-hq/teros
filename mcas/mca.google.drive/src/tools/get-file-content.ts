import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const getFileContent: ToolConfig = {
  description: 'Get the text content of a file (works for Google Docs, text files, etc.)',
  parameters: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        description: 'ID of the file to read',
      },
      mimeType: {
        type: 'string',
        description: "Optional: Export MIME type for Google Docs (e.g., 'text/plain', 'text/html')",
      },
    },
    required: ['fileId'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { fileId, mimeType: exportMimeType } = args as {
      fileId: string;
      mimeType?: string;
    };

    return withAuthRetry(
      context,
      async () => {
        const fileInfo = await clients.drive.files.get({
          fileId,
          fields: 'mimeType, name',
        });

        let content: string;

        // If it's a Google Doc, export as text
        if (fileInfo.data.mimeType?.includes('google-apps')) {
          const mimeType = exportMimeType || 'text/plain';
          const response = await clients.drive.files.export(
            { fileId, mimeType },
            { responseType: 'stream' },
          );

          const chunks: Buffer[] = [];
          for await (const chunk of response.data as AsyncIterable<Buffer>) {
            chunks.push(Buffer.from(chunk));
          }
          content = Buffer.concat(chunks).toString('utf-8');
        } else {
          // For regular files, download the content
          const response = await clients.drive.files.get(
            { fileId, alt: 'media' },
            { responseType: 'stream' },
          );

          const chunks: Buffer[] = [];
          for await (const chunk of response.data as AsyncIterable<Buffer>) {
            chunks.push(Buffer.from(chunk));
          }
          content = Buffer.concat(chunks).toString('utf-8');
        }

        return {
          name: fileInfo.data.name,
          mimeType: fileInfo.data.mimeType,
          content,
        };
      },
      'get-file-content',
    );
  },
};
