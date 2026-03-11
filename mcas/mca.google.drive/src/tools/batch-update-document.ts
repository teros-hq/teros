import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

interface Operation {
  type: 'insert' | 'delete' | 'replace';
  text?: string;
  index?: number;
  startIndex?: number;
  endIndex?: number;
  findText?: string;
  replaceText?: string;
}

export const batchUpdateDocument: ToolConfig = {
  description:
    'Perform multiple operations on a Google Doc in a single atomic request. Supports insert, delete, and replace operations.',
  parameters: {
    type: 'object',
    properties: {
      documentId: {
        type: 'string',
        description: 'The ID of the document',
      },
      operations: {
        type: 'array',
        description: 'Array of operations to perform',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['insert', 'delete', 'replace'],
              description: 'Operation type',
            },
            text: {
              type: 'string',
              description: 'Text to insert (for insert/replace)',
            },
            index: {
              type: 'number',
              description: 'Position index (for insert/delete)',
            },
            startIndex: {
              type: 'number',
              description: 'Start index for delete range',
            },
            endIndex: {
              type: 'number',
              description: 'End index for delete range',
            },
            findText: {
              type: 'string',
              description: 'Text to find (for replace)',
            },
            replaceText: {
              type: 'string',
              description: 'Text to replace with (for replace)',
            },
          },
          required: ['type'],
        },
      },
    },
    required: ['documentId', 'operations'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { documentId, operations } = args as {
      documentId: string;
      operations: Operation[];
    };

    return withAuthRetry(
      context,
      async () => {
        const requests: any[] = [];

        for (const op of operations) {
          switch (op.type) {
            case 'insert':
              if (op.text && op.index !== undefined) {
                requests.push({
                  insertText: {
                    location: { index: op.index },
                    text: op.text,
                  },
                });
              }
              break;

            case 'delete':
              if (op.startIndex !== undefined && op.endIndex !== undefined) {
                requests.push({
                  deleteContentRange: {
                    range: {
                      startIndex: op.startIndex,
                      endIndex: op.endIndex,
                    },
                  },
                });
              }
              break;

            case 'replace':
              if (op.findText && op.replaceText !== undefined) {
                requests.push({
                  replaceAllText: {
                    containsText: {
                      text: op.findText,
                      matchCase: true,
                    },
                    replaceText: op.replaceText,
                  },
                });
              }
              break;
          }
        }

        if (requests.length === 0) {
          return {
            success: false,
            message: 'No valid operations to perform',
          };
        }

        const response = await clients.docs.documents.batchUpdate({
          documentId,
          requestBody: { requests },
        });

        return {
          success: true,
          operationsPerformed: requests.length,
          replies: response.data.replies,
        };
      },
      'batch-update-document',
    );
  },
};
