import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const deleteSlide: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Delete a slide from a Google Slides presentation by its objectId or 0-based index.',
  parameters: {
    type: 'object',
    properties: {
      presentationId: {
        type: 'string',
        description: 'The ID of the presentation',
      },
      slideObjectId: {
        type: 'string',
        description: 'The objectId of the slide to delete. If provided, takes precedence over slideIndex.',
      },
      slideIndex: {
        type: 'number',
        description: '0-based index of the slide to delete (used if slideObjectId is not provided).',
      },
    },
    required: ['presentationId'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { presentationId, slideObjectId, slideIndex } = args as {
      presentationId: string;
      slideObjectId?: string;
      slideIndex?: number;
    };

    return withAuthRetry(
      context,
      async () => {
        let targetObjectId: string | undefined = slideObjectId;

        // If no objectId, resolve from index
        if (!targetObjectId) {
          if (slideIndex === undefined) {
            throw new Error('Either slideObjectId or slideIndex must be provided.');
          }

          const pres = await clients.slides.presentations.get({ presentationId });
          const slides = pres.data.slides || [];

          if (slideIndex < 0 || slideIndex >= slides.length) {
            throw new Error(
              `Slide index ${slideIndex} is out of range. Presentation has ${slides.length} slides.`,
            );
          }

          targetObjectId = slides[slideIndex].objectId;
        }

        if (!targetObjectId) {
          throw new Error('Could not determine the slide objectId to delete.');
        }

        await clients.slides.presentations.batchUpdate({
          presentationId,
          requestBody: {
            requests: [
              {
                deleteObject: {
                  objectId: targetObjectId,
                },
              },
            ],
          },
        });

        return {
          success: true,
          presentationId,
          deletedObjectId: targetObjectId,
          message: `Slide '${targetObjectId}' deleted successfully.`,
        };
      },
      'delete-slide',
    );
  },
};
