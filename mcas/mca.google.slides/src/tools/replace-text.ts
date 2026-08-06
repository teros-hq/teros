import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import {
  ensureAuthenticated,
  initializeGoogleClients,
  processEscapeSequences,
  withAuthRetry,
} from '../lib';

export const replaceText: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Replace all occurrences of a text string across an entire Google Slides presentation. ' +
    'Uses the Slides API replaceAllText request to find and replace text in all slides at once.',
  parameters: {
    type: 'object',
    properties: {
      presentationId: {
        type: 'string',
        description: 'The ID of the presentation',
      },
      findText: {
        type: 'string',
        description: 'Text to find and replace',
      },
      replaceText: {
        type: 'string',
        description: 'Text to replace with. Supports \\n for line breaks.',
      },
      matchCase: {
        type: 'boolean',
        description: 'Whether to match case (default: true)',
      },
    },
    required: ['presentationId', 'findText', 'replaceText'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const {
      presentationId,
      findText,
      replaceText: rawReplaceText,
      matchCase = true,
    } = args as {
      presentationId: string;
      findText: string;
      replaceText: string;
      matchCase?: boolean;
    };

    const replaceText = processEscapeSequences(rawReplaceText);

    return withAuthRetry(
      context,
      async () => {
        const response = await clients.slides.presentations.batchUpdate({
          presentationId,
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

        const occurrencesChanged =
          response.data.replies?.[0]?.replaceAllText?.occurrencesChanged || 0;

        return {
          success: true,
          presentationId,
          occurrencesChanged,
        };
      },
      'replace-text',
    );
  },
};
