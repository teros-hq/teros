import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { Readable } from 'stream';
import { ALL_DRIVES, ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';
import { CONTENT_TYPE_SOURCE_MIME, type DocumentContentType, GOOGLE_NATIVE_MIME } from './_mime';

export const createDocument: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Create a native, editable Google Doc from text content. Pass the body as HTML (default, best formatting), Markdown, or plain text — Drive converts it into a real Google Doc, NOT an .html file. Use this to author documents; use upload-file only for existing local files.',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Title (file name) of the new Google Doc',
      },
      content: {
        type: 'string',
        description: 'The document body. Interpreted according to contentType.',
      },
      contentType: {
        type: 'string',
        enum: ['html', 'markdown', 'text'],
        description:
          'How to interpret content: "html" (default, richest formatting), "markdown", or "text" (plain). Drive converts it to a native Google Doc.',
      },
      parentFolderId: {
        type: 'string',
        description: 'Optional: ID of the folder to create the doc in (default: root)',
      },
    },
    required: ['title', 'content'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const {
      title,
      content,
      contentType = 'html',
      parentFolderId,
    } = args as {
      title: string;
      content: string;
      contentType?: DocumentContentType;
      parentFolderId?: string;
    };

    if (typeof title !== 'string' || title.trim().length === 0) {
      throw new Error('title is required and must be a non-empty string.');
    }
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error('content is required and must be a non-empty string.');
    }
    const sourceMimeType = CONTENT_TYPE_SOURCE_MIME[contentType as DocumentContentType];
    if (!sourceMimeType) {
      throw new Error(
        `Invalid contentType "${contentType}". Expected one of: ${Object.keys(CONTENT_TYPE_SOURCE_MIME).join(', ')}.`,
      );
    }

    return withAuthRetry(
      context,
      async () => {
        const fileMetadata: { name: string; mimeType: string; parents?: string[] } = {
          name: title,
          // Native Google Doc target → Drive converts the uploaded source bytes
          // (text/html | text/markdown | text/plain) into an editable Doc.
          mimeType: GOOGLE_NATIVE_MIME.document,
        };

        if (parentFolderId) {
          fileMetadata.parents = [parentFolderId];
        }

        const media = {
          mimeType: sourceMimeType,
          // Single-chunk stream of the UTF-8 body (array-wrap avoids per-char chunking).
          body: Readable.from([Buffer.from(content, 'utf-8')]),
        };

        const response = await clients.drive.files.create({
          ...ALL_DRIVES,
          requestBody: fileMetadata,
          media,
          fields: 'id, name, mimeType, webViewLink',
        });

        return response.data;
      },
      'create-document',
    );
  },
};
