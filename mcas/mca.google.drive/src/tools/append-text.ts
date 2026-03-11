import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const appendText: ToolConfig = {
  description: 'Append text to the end of a Google Doc.',
  parameters: {
    type: 'object',
    properties: {
      documentId: {
        type: 'string',
        description: 'The ID of the document',
      },
      text: {
        type: 'string',
        description: 'Text to append',
      },
    },
    required: ['documentId', 'text'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { documentId, text } = args as {
      documentId: string;
      text: string;
    };

    return withAuthRetry(
      context,
      async () => {
        // First, get the document to find the end index
        const doc = await clients.docs.documents.get({
          documentId,
        });

        // The end index is the last content element's endIndex minus 1
        // (to account for the final newline)
        const body = doc.data.body;
        let endIndex = 1;

        if (body?.content) {
          const lastElement = body.content[body.content.length - 1];
          if (lastElement?.endIndex) {
            endIndex = lastElement.endIndex - 1;
          }
        }

        await clients.docs.documents.batchUpdate({
          documentId,
          requestBody: {
            requests: [
              {
                insertText: {
                  location: {
                    index: endIndex,
                  },
                  text,
                },
              },
            ],
          },
        });

        return {
          success: true,
          message: `Appended ${text.length} characters to document`,
        };
      },
      'append-text',
    );
  },
};
