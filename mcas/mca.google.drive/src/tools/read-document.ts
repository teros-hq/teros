import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import {
  ensureAuthenticated,
  extractTextFromDocument,
  initializeGoogleClients,
  withAuthRetry,
} from '../lib';

export const readDocument: ToolConfig = {
  description: 'Read content from a Google Docs document.',
  parameters: {
    type: 'object',
    properties: {
      documentId: {
        type: 'string',
        description: 'The ID of the document',
      },
    },
    required: ['documentId'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { documentId } = args as { documentId: string };

    return withAuthRetry(
      context,
      async () => {
        const response = await clients.docs.documents.get({
          documentId,
        });

        const doc = response.data;
        const text = extractTextFromDocument(doc);

        return {
          title: doc.title,
          documentId: doc.documentId,
          content: text,
        };
      },
      'read-document',
    );
  },
};
