import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';

export const sendHtmlFile: ToolConfig = {
  description:
    'Send an HTML file to the user. The file will be rendered inline in the chat (fetched from its path) AND can be opened in a dedicated FileViewer window that auto-refreshes when the file changes. Use this when you want the user to see a live preview of an HTML file you are editing.',
  parameters: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description:
          'Absolute path to the HTML file (e.g., \'/workspace/mockup.html\'). The file must exist on the shared volume.',
      },
      caption: {
        type: 'string',
        description: 'Optional caption/description for the widget',
      },
    },
    required: ['filePath'],
  },
  handler: async (args) => {
    const filePath = args?.filePath as string;
    const caption = args?.caption as string | undefined;

    if (!filePath) {
      throw new Error('filePath is required');
    }

    if (!filePath.endsWith('.html') && !filePath.endsWith('.htm')) {
      throw new Error('filePath must point to an HTML file (.html or .htm)');
    }

    return {
      success: true,
      __teros_message__: {
        type: 'html_file',
        filePath,
        caption,
      },
      description: caption
        ? `HTML file sent: ${caption} (${filePath})`
        : `HTML file sent to user: ${filePath}`,
    };
  },
};
