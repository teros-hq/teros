import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const createForm: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Create a new Google Form with a title. Returns the form ID and responder URL.',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'The title of the form (shown to respondents)',
      },
      documentTitle: {
        type: 'string',
        description:
          'Optional: The document title shown in Google Drive (defaults to the form title if not provided)',
      },
    },
    required: ['title'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { title, documentTitle } = args as {
      title: string;
      documentTitle?: string;
    };

    return withAuthRetry(
      context,
      async () => {
        const response = await clients.forms.forms.create({
          requestBody: {
            info: {
              title,
              documentTitle: documentTitle || title,
            },
          },
        });

        const form = response.data;

        return {
          formId: form.formId,
          title: form.info?.title,
          documentTitle: form.info?.documentTitle,
          responderUri: form.responderUri,
          linkedSheetId: form.linkedSheetId,
          revisionId: form.revisionId,
        };
      },
      'create-form',
    );
  },
};
