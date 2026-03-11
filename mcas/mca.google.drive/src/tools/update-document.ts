import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const updateDocument: ToolConfig = {
  description:
    'Replace all occurrences of a text string in a Google Doc. Useful for updating placeholders or specific content.',
  parameters: {
    type: 'object',
    properties: {
      documentId: {
        type: 'string',
        description: 'The ID of the document',
      },
      findText: {
        type: 'string',
        description: 'Text to find and replace',
      },
      replaceText: {
        type: 'string',
        description: 'Text to replace with',
      },
      matchCase: {
        type: 'boolean',
        description: 'Whether to match case (default: true)',
      },
    },
    required: ['documentId', 'findText', 'replaceText'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const {
      documentId,
      findText,
      replaceText,
      matchCase = true,
    } = args as {
      documentId: string;
      findText: string;
      replaceText: string;
      matchCase?: boolean;
    };

    return withAuthRetry(
      context,
      async () => {
        const response = await clients.docs.documents.batchUpdate({
          documentId,
          requestBody: {
            requests: [
              {
                replaceAllText: {
                  containsText: {
                    text: findText,
                    matchCase,
                  },
                  replaceText,
                },
              },
            ],
          },
        });

        const replaceResult = response.data.replies?.[0]?.replaceAllText;

        return {
          success: true,
          occurrencesChanged: replaceResult?.occurrencesChanged || 0,
        };
      },
      'update-document',
    );
  },
};
