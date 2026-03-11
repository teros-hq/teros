import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';

export const sendHtml: ToolConfig = {
  description:
    'Send an HTML widget to the user. The HTML will be rendered directly in the chat. Use this to display UI mockups, interactive previews, styled tables, diagrams, or any visual content that can be represented with HTML/CSS. The HTML is sandboxed for security.',
  parameters: {
    type: 'object',
    properties: {
      html: {
        type: 'string',
        description: 'HTML content to render. Can include inline <style> tags for CSS.',
      },
      caption: {
        type: 'string',
        description: 'Optional caption/description for the widget',
      },
      height: {
        type: 'number',
        description:
          'Optional fixed height in pixels. If not provided, height will be auto-calculated.',
      },
    },
    required: ['html'],
  },
  handler: async (args) => {
    const html = args?.html as string;
    const caption = args?.caption as string | undefined;
    const height = args?.height as number | undefined;

    if (!html) {
      throw new Error('html is required');
    }

    return {
      success: true,
      __teros_message__: {
        type: 'html',
        html,
        caption,
        height,
      },
      description: caption ? `HTML widget sent: ${caption}` : 'HTML widget sent to user',
    };
  },
};
