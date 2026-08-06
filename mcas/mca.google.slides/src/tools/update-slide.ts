import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import {
  ensureAuthenticated,
  initializeGoogleClients,
  processEscapeSequences,
  withAuthRetry,
} from '../lib';

export const updateSlide: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Update the text content of a slide in a Google Slides presentation. ' +
    'Can target a slide by its objectId or by 0-based slide index. ' +
    'Uses insertText to add text to the first text element found on the slide, ' +
    'or replaceAllText to replace text across the entire presentation.',
  parameters: {
    type: 'object',
    properties: {
      presentationId: {
        type: 'string',
        description: 'The ID of the presentation',
      },
      slideObjectId: {
        type: 'string',
        description: 'The objectId of the slide to update. If provided, takes precedence over slideIndex.',
      },
      slideIndex: {
        type: 'number',
        description: '0-based index of the slide to update (used if slideObjectId is not provided).',
      },
      text: {
        type: 'string',
        description: 'Text to insert into the slide. Supports \\n for line breaks.',
      },
      mode: {
        type: 'string',
        enum: ['insert', 'replace'],
        description:
          'insert (default): insert text into the first text shape on the slide. ' +
          'replace: replace all occurrences of findText with text across the entire presentation.',
      },
      findText: {
        type: 'string',
        description: 'Text to find (required when mode=replace).',
      },
      matchCase: {
        type: 'boolean',
        description: 'Whether to match case when replacing (default: true). Only used with mode=replace.',
      },
    },
    required: ['presentationId', 'text'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const {
      presentationId,
      slideObjectId,
      slideIndex,
      text: rawText,
      mode = 'insert',
      findText,
      matchCase = true,
    } = args as {
      presentationId: string;
      slideObjectId?: string;
      slideIndex?: number;
      text: string;
      mode?: 'insert' | 'replace';
      findText?: string;
      matchCase?: boolean;
    };

    const text = processEscapeSequences(rawText);

    return withAuthRetry(
      context,
      async () => {
        if (mode === 'replace') {
          if (!findText) {
            throw new Error('findText is required when mode=replace.');
          }

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
                    replaceText: text,
                  },
                },
              ],
            },
          });

          const occurrencesChanged =
            response.data.replies?.[0]?.replaceAllText?.occurrencesChanged || 0;

          return {
            success: true,
            mode: 'replace',
            occurrencesChanged,
            presentationId,
          };
        }

        // mode === 'insert'
        // We need to find the target slide and its first text shape
        const pres = await clients.slides.presentations.get({ presentationId });
        const slides = pres.data.slides || [];

        let targetSlide: typeof slides[0] | undefined;

        if (slideObjectId) {
          targetSlide = slides.find((s) => s.objectId === slideObjectId);
          if (!targetSlide) {
            throw new Error(
              `Slide with objectId '${slideObjectId}' not found in presentation.`,
            );
          }
        } else if (slideIndex !== undefined) {
          if (slideIndex < 0 || slideIndex >= slides.length) {
            throw new Error(
              `Slide index ${slideIndex} is out of range. Presentation has ${slides.length} slides.`,
            );
          }
          targetSlide = slides[slideIndex];
        } else {
          throw new Error('Either slideObjectId or slideIndex must be provided for insert mode.');
        }

        // Find the first text shape on the slide
        let textShapeObjectId: string | undefined;
        for (const element of targetSlide.pageElements || []) {
          if (element.shape?.text && element.objectId) {
            textShapeObjectId = element.objectId;
            break;
          }
        }

        // If no existing text shape, create a new text box
        if (!textShapeObjectId) {
          const slideId = targetSlide.objectId!;
          const newTextBoxId = `textBox_${Date.now()}`;

          const response = await clients.slides.presentations.batchUpdate({
            presentationId,
            requestBody: {
              requests: [
                {
                  createShape: {
                    objectId: newTextBoxId,
                    shapeType: 'TEXT_BOX',
                    elementProperties: {
                      pageObjectId: slideId,
                      size: {
                        width: { magnitude: 300, unit: 'PT' },
                        height: { magnitude: 50, unit: 'PT' },
                      },
                      transform: {
                        scaleX: 1,
                        scaleY: 1,
                        translateX: 100,
                        translateY: 100,
                        unit: 'PT',
                      },
                    },
                  },
                },
                {
                  insertText: {
                    objectId: newTextBoxId,
                    text,
                  },
                },
              ],
            },
          });

          return {
            success: true,
            mode: 'insert',
            presentationId,
            slideObjectId: targetSlide.objectId,
            textShapeObjectId: newTextBoxId,
            message: 'Created a new text box and inserted text.',
          };
        }

        // Insert text into the existing text shape
        await clients.slides.presentations.batchUpdate({
          presentationId,
          requestBody: {
            requests: [
              {
                insertText: {
                  objectId: textShapeObjectId,
                  text,
                },
              },
            ],
          },
        });

        return {
          success: true,
          mode: 'insert',
          presentationId,
          slideObjectId: targetSlide.objectId,
          textShapeObjectId,
          message: `Inserted text into shape ${textShapeObjectId}.`,
        };
      },
      'update-slide',
    );
  },
};
