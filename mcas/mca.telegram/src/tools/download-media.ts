import type { ToolConfig } from '@teros/mca-sdk';
import fs from 'fs/promises';
import path from 'path';
import { requireAuthorizedClient, resolveChat, runCatched } from '../lib/client';

export const downloadMedia: ToolConfig = {
  annotations: { readOnlyHint: false, safeWriteHint: true },
  description:
    'Download the media attached to a Telegram message (photo, video, audio, document, sticker...) and save it to a local path. Use /workspace/... to save into the user\'s workspace so other tools and agents can access the file.',
  parameters: {
    type: 'object',
    properties: {
      chat: {
        type: 'string',
        description: 'Chat where the message lives: chat ID, @username or t.me link',
      },
      messageId: {
        type: 'number',
        description: 'ID of the message with the media (from get-chat-history or an event)',
      },
      outputPath: {
        type: 'string',
        description: 'Local path to save the file (e.g. "/workspace/photo.jpg"). Defaults to /workspace/telegram-media/<messageId>.<ext>',
      },
      thumb: {
        type: 'boolean',
        description: 'Download only the thumbnail instead of the full media (default: false)',
      },
    },
    required: ['chat', 'messageId'],
  },
  handler: async (args) =>
    runCatched(async () => {
      const { chat, messageId, outputPath, thumb = false } = args as {
        chat: string;
        messageId: number;
        outputPath?: string;
        thumb?: boolean;
      };
      const client = await requireAuthorizedClient();
      const entity = await resolveChat(client, chat);
      const [msg] = await client.getMessages(entity, { ids: [messageId] });
      if (!msg) {
        return { success: false, error: `Message ${messageId} not found in ${chat}` };
      }
      const media = (msg as unknown as { media?: unknown }).media;
      if (!media) {
        return { success: false, error: 'Message has no media attached' };
      }

      const buffer = await client.downloadMedia(msg as never, {
        thumb: thumb ? 0 : undefined,
      });
      if (!buffer) {
        return { success: false, error: 'Media could not be downloaded (may be expired, protected, or empty)' };
      }

      // Infer a sensible extension from the media's mime type when the caller
      // did not provide a full path with one.
      let outPath = outputPath;
      if (!outPath) {
        const doc = (media as { document?: { mimeType?: string } }).document;
        const mime = doc?.mimeType || 'application/octet-stream';
        const ext = mime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
        outPath = `/workspace/telegram-media/${messageId}.${ext}`;
      }
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      await fs.writeFile(outPath, buffer as Buffer);

      const size = (buffer as Buffer).byteLength;
      return {
        success: true,
        outputPath: outPath,
        sizeBytes: size,
        messageId,
        chat,
      };
    }),
};
