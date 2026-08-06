import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ALL_DRIVES, ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';
import { isTextualMimeType } from './_mime';

async function streamToString(stream: AsyncIterable<Buffer>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export const getFileContent: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get the plain-text content of a Google Doc or text file. Does NOT extract text from binary files (PDF, Word, etc.) — for those, download the file and use the file-processor "file-to-markdown" tool.',
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
          ...ALL_DRIVES,
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
          content = await streamToString(response.data as AsyncIterable<Buffer>);
        } else {
          // Regular (non-Google) file. Only decode if it is actually text;
          // decoding a binary file (PDF/Word/image) as UTF-8 returns garbage
          // that the model cannot use, which historically led agents to invent
          // a "file processing service is down" excuse.
          const fileMimeType = fileInfo.data.mimeType ?? '';
          if (!isTextualMimeType(fileMimeType)) {
            throw new Error(
              `[UNSUPPORTED_BINARY] "${fileInfo.data.name}" is a binary file (${fileMimeType || 'unknown type'}) with no directly readable text. ` +
                'get-file-content only returns plain-text or Google Docs content. ' +
                'To read a PDF or Word document, download it with the download-file tool and then convert it to text with the file-processor "file-to-markdown" tool.',
            );
          }

          const response = await clients.drive.files.get(
            { ...ALL_DRIVES, fileId, alt: 'media' },
            { responseType: 'stream' },
          );
          content = await streamToString(response.data as AsyncIterable<Buffer>);
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
