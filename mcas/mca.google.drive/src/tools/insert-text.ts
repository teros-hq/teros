import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const insertText: ToolConfig = {
  description:
    'Insert text at a specific position in a Google Doc. Index 1 is the start of the document.',
  parameters: {
    type: 'object',
    properties: {
      documentId: {
        type: 'string',
        description: 'The ID of the document',
      },
      text: {
        type: 'string',
        description: 'Text to insert',
      },
      index: {
        type: 'number',
        description:
          'Position to insert at (1 = start of document). Use read-document to find positions.',
      },
    },
    required: ['documentId', 'text', 'index'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { documentId, text, index } = args as {
      documentId: string;
      text: string;
      index: number;
    };

    return withAuthRetry(
      context,
      async () => {
        await clients.docs.documents.batchUpdate({
          documentId,
          requestBody: {
            requests: [
              {
                insertText: {
                  location: {
                    index,
                  },
                  text,
                },
              },
            ],
          },
        });

        return {
          success: true,
          message: `Inserted ${text.length} characters at index ${index}`,
        };
      },
      'insert-text',
    );
  },
};
