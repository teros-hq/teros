import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import {
  ensureAuthenticated,
  extractTextFromSlide,
  initializeGoogleClients,
  withAuthRetry,
} from '../lib';

export const readPresentation: ToolConfig = {
  description: 'Read slide content from a Google Slides presentation.',
  parameters: {
    type: 'object',
    properties: {
      presentationId: {
        type: 'string',
        description: 'The ID of the presentation',
      },
    },
    required: ['presentationId'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { presentationId } = args as { presentationId: string };

    return withAuthRetry(
      context,
      async () => {
        const response = await clients.slides.presentations.get({
          presentationId,
        });

        const presentation = response.data;

        const slides =
          presentation.slides?.map((slide, index) => ({
            slideNumber: index + 1,
            objectId: slide.objectId,
            text: extractTextFromSlide(slide),
          })) || [];

        return {
          title: presentation.title,
          slideCount: slides.length,
          slides,
        };
      },
      'read-presentation',
    );
  },
};
