import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, formatItem, initializeGoogleClients, withAuthRetry } from '../lib';

export const getForm: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get the full structure of a Google Form by its ID, including all items and questions.',
  parameters: {
    type: 'object',
    properties: {
      formId: {
        type: 'string',
        description: 'The ID of the form to retrieve',
      },
    },
    required: ['formId'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { formId } = args as { formId: string };

    return withAuthRetry(
      context,
      async () => {
        const response = await clients.forms.forms.get({ formId });
        const form = response.data;

        return {
          formId: form.formId,
          title: form.info?.title,
          documentTitle: form.info?.documentTitle,
          description: form.info?.description,
          responderUri: form.responderUri,
          linkedSheetId: form.linkedSheetId,
          revisionId: form.revisionId,
          settings: form.settings,
          items: (form.items || []).map(formatItem),
        };
      },
      'get-form',
    );
  },
};
