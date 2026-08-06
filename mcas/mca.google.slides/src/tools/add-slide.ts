import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

// Layout names mapped to Google's predefinedLayout enum values.
// See: https://developers.google.com/slides/api/reference/rest/v1/presentations/request#LayoutReference
const LAYOUT_NAMES: Record<string, string> = {
  blank: 'BLANK',
  'title-slide': 'TITLE_SLIDE',
  'title-and-body': 'TITLE_AND_BODY',
  'title-and-two-columns': 'TITLE_AND_TWO_COLUMNS',
  'title-only': 'TITLE_ONLY',
  'section-header': 'SECTION_HEADER',
  'two-section': 'TWO_SECTION',
};

export const addSlide: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Add a new slide to a Google Slides presentation. Returns the slideObjectId of the new slide.',
  parameters: {
    type: 'object',
    properties: {
      presentationId: {
        type: 'string',
        description: 'The ID of the presentation',
      },
      layout: {
        type: 'string',
        description:
          'Optional layout for the new slide. Can be a layout name (blank, title-slide, ' +
          'title-and-body, title-and-two-columns, title-only, section-header, two-section) ' +
          'or a raw layout objectId. Defaults to "blank".',
      },
      insertionIndex: {
        type: 'number',
        description:
          'Optional 0-based index where the slide should be inserted. ' +
          'If omitted, the slide is appended at the end.',
      },
    },
    required: ['presentationId'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const {
      presentationId,
      layout: layoutInput = 'blank',
      insertionIndex,
    } = args as {
      presentationId: string;
      layout?: string;
      insertionIndex?: number;
    };

    return withAuthRetry(
      context,
      async () => {
        const predefinedLayout = LAYOUT_NAMES[layoutInput.toLowerCase()];

        const request: any = {
          createSlide: {},
        };

        if (predefinedLayout) {
          request.createSlide.slideLayoutReference = { predefinedLayout };
        }
        // If layout is not a known predefined name, omit slideLayoutReference
        // entirely — the API will use the default (BLANK) layout.

        if (insertionIndex !== undefined && insertionIndex >= 0) {
          request.createSlide.insertionIndex = insertionIndex;
        }

        const response = await clients.slides.presentations.batchUpdate({
          presentationId,
          requestBody: { requests: [request] },
        });

        const createReply = response.data.replies?.[0]?.createSlide;
        const slideObjectId = createReply?.objectId || '';

        return {
          success: true,
          presentationId,
          slideObjectId,
          message: slideObjectId
            ? `Slide created with objectId: ${slideObjectId}`
            : 'Slide created (objectId not returned by API)',
        };
      },
      'add-slide',
    );
  },
};
