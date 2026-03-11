import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import {
  ensureAuthenticated,
  extractTextFromSlide,
  initializeGoogleClients,
  withAuthRetry,
} from '../lib';

export const readSlide: ToolConfig = {
  description: 'Read a specific slide from a Google Slides presentation.',
  parameters: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        description: 'ID of the Google Slides file',
      },
      slideIndex: {
        type: 'number',
        description: '0-based index of the slide to read (0 = first slide)',
      },
    },
    required: ['fileId', 'slideIndex'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { fileId, slideIndex } = args as { fileId: string; slideIndex: number };

    return withAuthRetry(
      context,
      async () => {
        const response = await clients.slides.presentations.get({
          presentationId: fileId,
        });

        const slides = response.data.slides || [];

        if (slideIndex < 0 || slideIndex >= slides.length) {
          throw new Error(
            `Slide index ${slideIndex} is out of range. Presentation has ${slides.length} slides.`,
          );
        }

        const slide = slides[slideIndex];

        return {
          slideNumber: slideIndex + 1,
          totalSlides: slides.length,
          objectId: slide.objectId,
          text: extractTextFromSlide(slide),
        };
      },
      'read-slide',
    );
  },
};
