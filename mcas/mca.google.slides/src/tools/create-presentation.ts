import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const createPresentation: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Create a new Google Slides presentation with a title. Returns the presentation ID and URL.',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Title of the new presentation',
      },
    },
    required: ['title'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { title } = args as { title: string };

    if (typeof title !== 'string' || title.trim().length === 0) {
      throw new Error('title is required and must be a non-empty string.');
    }

    return withAuthRetry(
      context,
      async () => {
        const response = await clients.slides.presentations.create({
          requestBody: {
            title,
          },
        });

        const presentationId = response.data.presentationId!;
        const presentationUrl = `https://docs.google.com/presentation/d/${presentationId}/edit`;

        return {
          presentationId,
          title,
          url: presentationUrl,
        };
      },
      'create-presentation',
    );
  },
};
