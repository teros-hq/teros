import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, formatAnswer, initializeGoogleClients, withAuthRetry } from '../lib';

export const getResponse: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get a specific response to a Google Form by its response ID.',
  parameters: {
    type: 'object',
    properties: {
      formId: {
        type: 'string',
        description: 'The ID of the form',
      },
      responseId: {
        type: 'string',
        description: 'The ID of the response to retrieve',
      },
    },
    required: ['formId', 'responseId'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { formId, responseId } = args as { formId: string; responseId: string };

    return withAuthRetry(
      context,
      async () => {
        const response = await clients.forms.forms.responses.get({ formId, responseId });
        const r = response.data;

        return {
          responseId: r.responseId,
          createTime: r.createTime,
          lastSubmittedTime: r.lastSubmittedTime,
          respondentEmail: r.respondentEmail,
          totalScore: r.totalScore,
          answers: r.answers
            ? Object.entries(r.answers).reduce(
                (acc, [questionId, answer]) => {
                  acc[questionId] = formatAnswer(answer);
                  return acc;
                },
                {} as Record<string, any>,
              )
            : {},
        };
      },
      'get-response',
    );
  },
};
