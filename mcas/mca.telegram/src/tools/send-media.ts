import type { ToolConfig } from '@teros/mca-sdk';
import fs from 'fs';
import { CustomFile } from 'teleproto/client/uploads';
import { requireAuthorizedClient, resolveChat, serializeMessage, runCatched } from '../lib/client';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.avi', '.mkv', '.mov', '.webm', '.m4v']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.ogg', '.m4a', '.wav', '.flac', '.opus']);

export const sendMedia: ToolConfig = {
  annotations: { readOnlyHint: false, safeWriteHint: true },
  description:
    'Send a file (image, video, audio or document) to a Telegram chat. Reads the file from a local path inside the container — use /workspace/... for files in the user\'s workspace volume, or a public HTTPS URL.',
  parameters: {
    type: 'object',
    properties: {
      chat: {
        type: 'string',
        description: 'Destination: chat ID from list-chats, @username, or t.me link',
      },
      file: {
        type: 'string',
        description: 'Local file path (e.g. "/workspace/report.pdf") or public HTTPS URL',
      },
      caption: {
        type: 'string',
        description: 'Optional caption shown with the media (max 1024 characters)',
      },
      asDocument: {
        type: 'boolean',
        description: 'Send as a plain document instead of auto-detecting image/video/audio type (default: false)',
      },
      asVoiceNote: {
        type: 'boolean',
        description: 'Send an audio file as a voice note (default: false)',
      },
      replyToMsgId: {
        type: 'number',
        description: 'Message ID to reply to (optional)',
      },
    },
    required: ['chat', 'file'],
  },
  handler: async (args) =>
    runCatched(async () => {
      const { chat, file, caption, asDocument = false, asVoiceNote = false, replyToMsgId } = args as {
        chat: string;
        file: string;
        caption?: string;
        asDocument?: boolean;
        asVoiceNote?: boolean;
        replyToMsgId?: number;
      };
      if (caption && caption.length > 1024) {
        return { success: false, error: `Caption is ${caption.length} characters — Telegram allows max 1024.` };
      }

      let fileArg: string | CustomFile;
      let filename: string;
      if (/^https?:\/\//i.test(file)) {
        // GramJS downloads and uploads remote URLs itself.
        fileArg = file;
        filename = file.split('/').pop() || 'file';
      } else {
        if (!fs.existsSync(file)) {
          return { success: false, error: `File not found: ${file}. Use a /workspace/... path or a public HTTPS URL.` };
        }
        const stat = fs.statSync(file);
        if (stat.size > 2 * 1024 * 1024 * 1024) {
          return { success: false, error: 'File exceeds Telegram\'s 2 GB upload limit.' };
        }
        filename = file.split('/').pop() || 'file';
        const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
        // Auto-detection only for local files where we know the extension;
        // forceDocument keeps images/videos from being misinterpreted.
        const isImage = IMAGE_EXTENSIONS.has(ext);
        const isVideo = VIDEO_EXTENSIONS.has(ext);
        const isAudio = AUDIO_EXTENSIONS.has(ext);
        const forceDocument = asDocument || (!isImage && !isVideo && !isAudio);
        fileArg = new CustomFile(filename, stat.size, '', fs.readFileSync(file));
        const client = await requireAuthorizedClient();
        const entity = await resolveChat(client, chat);
        const sent = await client.sendFile(entity, {
          file: fileArg,
          caption: caption || undefined,
          forceDocument,
          voiceNote: asVoiceNote && isAudio,
          replyTo: replyToMsgId ?? undefined,
          workers: 1,
        });
        return { success: true, message: serializeMessage(sent) };
      }

      // Remote URL path
      const client = await requireAuthorizedClient();
      const entity = await resolveChat(client, chat);
      const sent = await client.sendFile(entity, {
        file: fileArg,
        caption: caption || undefined,
        forceDocument: asDocument,
        replyTo: replyToMsgId ?? undefined,
        workers: 1,
      });
      return { success: true, message: serializeMessage(sent) };
    }),
};
