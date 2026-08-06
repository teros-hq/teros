import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, processEscapeSequences, withAuthRetry } from '../lib';

export const createDocument: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Create a new Google Doc with a title and optional initial content. Returns the document ID and URL.',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Title of the new Google Doc',
      },
      content: {
        type: 'string',
        description:
          'Optional initial text content for the document. Supports \\n for line breaks.',
      },
    },
    required: ['title'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { title, content: rawContent } = args as {
      title: string;
      content?: string;
    };

    if (typeof title !== 'string' || title.trim().length === 0) {
      throw new Error('title is required and must be a non-empty string.');
    }

    return withAuthRetry(
      context,
      async () => {
        // Step 1: Create the document with a title
        const createResponse = await clients.docs.documents.create({
          requestBody: {
            title,
          },
        });

        const documentId = createResponse.data.documentId!;

        // Step 2: If content was provided, insert it at the beginning
        if (rawContent && rawContent.length > 0) {
          const content = processEscapeSequences(rawContent);

          await clients.docs.documents.batchUpdate({
            documentId,
            requestBody: {
              requests: [
                {
                  insertText: {
                    location: { index: 1 },
                    text: content,
                  },
                },
              ],
            },
          });
        }

        return {
          documentId,
          title,
          url: `https://docs.google.com/document/d/${documentId}/edit`,
        };
      },
      'create-document',
    );
  },
};
