import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const updateForm: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: `Update a Google Form using batch update requests. Supports adding, editing, and deleting items, as well as updating form info and settings.

Available request types in the \`requests\` array:

- **createItem**: Add a new item (question, section, etc.) at a specific location.
  \`{ createItem: { item: { title, questionItem: { question: { required, choiceQuestion | textQuestion | scaleQuestion | dateQuestion | timeQuestion } } }, location: { index: 0 } } }\`

- **updateItem**: Modify an existing item by its ID.
  \`{ updateItem: { item: { itemId, title, ... }, location: { index: 0 }, updateMask: "title,description" } }\`

- **deleteItem**: Remove an item by its location index.
  \`{ deleteItem: { location: { index: 0 } } }\`

- **updateFormInfo**: Update the form title, description, or document title.
  \`{ updateFormInfo: { info: { title, description, documentTitle }, updateMask: "title,description" } }\`

- **updateSettings**: Change form settings such as quiz mode or response collection.
  \`{ updateSettings: { settings: { quizSettings: { isQuiz: true } }, updateMask: "quizSettings.isQuiz" } }\`

See https://developers.google.com/forms/api/reference/rest/v1/forms/batchUpdate for full schemas.`,
  parameters: {
    type: 'object',
    properties: {
      formId: {
        type: 'string',
        description: 'The ID of the form to update',
      },
      requests: {
        type: 'array',
        description:
          'Array of update requests. Each request is one of: createItem, updateItem, deleteItem, updateFormInfo, or updateSettings.',
        items: {
          type: 'object',
        },
      },
    },
    required: ['formId', 'requests'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { formId, requests } = args as {
      formId: string;
      requests: Record<string, any>[];
    };

    return withAuthRetry(
      context,
      async () => {
        const response = await clients.forms.forms.batchUpdate({
          formId,
          requestBody: {
            requests,
            includeFormInResponse: true,
          },
        });

        const result = response.data;

        return {
          revisionId: result.revisionId,
          writeControl: result.writeControl,
          replies: result.replies,
          form: result.form
            ? {
                formId: result.form.formId,
                title: result.form.info?.title,
                documentTitle: result.form.info?.documentTitle,
                description: result.form.info?.description,
                responderUri: result.form.responderUri,
                itemCount: result.form.items?.length ?? 0,
              }
            : undefined,
        };
      },
      'update-form',
    );
  },
};
