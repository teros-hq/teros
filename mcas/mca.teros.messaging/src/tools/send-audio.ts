import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { resolveUrl } from '../lib';

export const sendAudio: ToolConfig = {
  description:
    'Send an audio file to the user. The audio will be playable in the chat. Supports public URLs or local file paths.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Public URL of the audio file (use this OR filePath)',
      },
      filePath: {
        type: 'string',
        description:
          "File path in /workspace/ (e.g., '/workspace/audio.mp3'). This is the shared volume accessible to all MCAs. Use this OR url.",
      },
      caption: {
        type: 'string',
        description: 'Optional caption/description for the audio',
      },
      duration: {
        type: 'number',
        description: 'Optional duration in seconds',
      },
      mimeType: {
        type: 'string',
        description: "Optional MIME type (e.g., 'audio/mp3')",
      },
    },
  },
  handler: async (args) => {
    const url = args?.url as string | undefined;
    const filePath = args?.filePath as string | undefined;
    const caption = args?.caption as string | undefined;
    const duration = args?.duration as number | undefined;
    const mimeType = args?.mimeType as string | undefined;

    const resolved = await resolveUrl(url, filePath);

    return {
      success: true,
      __teros_message__: {
        type: 'audio',
        url: resolved.url,
        caption,
        duration,
        mimeType: mimeType || resolved.mimeType,
      },
      description: caption ? `Audio sent: ${caption}` : 'Audio sent to user',
    };
  },
};
