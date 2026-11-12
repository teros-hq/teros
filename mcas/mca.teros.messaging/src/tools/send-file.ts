import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { basename, resolveUrl, extToMime } from '../lib';

/**
 * send-file — the ONE universal file-sending tool (FVU-REQ-1, spec v1.2.0).
 *
 * Accepts a public `url` OR a `filePath` on the shared workspace volume and
 * works for ANY file type — the agent never needs to know how each type is
 * rendered (markdown, image, pdf, audio/video, csv, json, txt, unknown…).
 *
 * Delivery modes (internal — the tool signature is unchanged):
 *   - `filePath` on the workspace volume → LIVE mode: the message carries the
 *     volume reference `{ filePath, workspaceId }` (pattern of send-html-file)
 *     so the FileViewer can watch the file and auto-refresh, PLUS a snapshot
 *     `url` (uploaded copy) so Download always works even if the volume file
 *     is later deleted.
 *   - `url` (or filePath outside the volume) → SNAPSHOT mode: uploaded media
 *     URL only, no watching.
 */
export const sendFile: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Send ANY file to the user — markdown, images, PDF, audio, video, CSV, JSON, text or any other type. The chat renders each type appropriately (markdown formatted, images inline, PDF readable inline, players for audio/video, tables for CSV, syntax highlight for JSON) and the user always gets the same 4 actions: download, open in FileViewer, fullscreen and share. Prefer this tool over send-image/send-audio/send-video/send-html-file. Supports public URLs or file paths on the shared /workspace volume.',
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Public URL of the file, objectId (obj_...) or objects URL (.../objects/obj_...) (use this OR filePath)',
      },
      filePath: {
        type: 'string',
        description:
          "File path in /workspace/ (e.g., '/workspace/report.md'). This is the shared volume accessible to all MCAs. Use this OR url. Volume files are sent as live references: the FileViewer auto-refreshes when the file changes.",
      },
      filename: {
        type: 'string',
        description:
          "Display name for the file (e.g., 'report.pdf'). Required if using url, optional for filePath.",
      },
      caption: {
        type: 'string',
        description: 'Optional caption/description for the file',
      },
      mimeType: {
        type: 'string',
        description: "Optional MIME type (e.g., 'application/pdf') — inferred from the extension when omitted",
      },
      size: {
        type: 'number',
        description: 'Optional file size in bytes — read from the file when omitted',
      },
    },
  },
  handler: async (args) => {
    const url = args?.url as string | undefined;
    const filePath = args?.filePath as string | undefined;
    const filename = args?.filename as string | undefined;
    const caption = args?.caption as string | undefined;
    const mimeType = args?.mimeType as string | undefined;
    const size = args?.size as number | undefined;

    if (url && filePath) {
      throw new Error("Provide either 'url' OR 'filePath', not both");
    }
    if (!url && !filePath) {
      throw new Error("Either 'url' or 'filePath' is required");
    }

    // Filename is required for URL, optional for filePath (will use basename)
    if (url && !filename) {
      throw new Error('filename is required when using url');
    }

    const actualFilename = filename || (filePath ? basename(filePath) : 'file');

    // ── LIVE mode: filePath inside the shared workspace volume ──────────────
    // The volume is mounted at /workspace (manifest runtime.workspaceMount).
    // Send the volume reference so the viewer can watch the file in vivo,
    // together with a snapshot upload so `url` (and Download) always works.
    const isVolumePath = !!filePath && filePath.startsWith('/workspace/');

    if (filePath && isVolumePath) {
      // Snapshot upload first — readFile/stat throws ENOENT with a clear
      // message if the file genuinely does not exist on the volume.
      const uploaded = await resolveUrl(undefined, filePath, actualFilename);

      return {
        success: true,
        __teros_message__: {
          type: 'file',
          url: uploaded.url,
          filename: actualFilename,
          caption,
          mimeType: mimeType || uploaded.mimeType || extToMime(actualFilename),
          size: size || uploaded.size,
          // Live reference (pattern send-html-file) → auto-refresh in FileViewer
          filePath,
          workspaceId: process.env.MCA_OWNER_ID,
        },
        description: `File sent: ${actualFilename} (live: ${filePath})`,
      };
    }

    // ── SNAPSHOT mode: external URL or non-volume local path ────────────────
    const resolved = await resolveUrl(url, filePath, actualFilename);

    return {
      success: true,
      __teros_message__: {
        type: 'file',
        url: resolved.url,
        filename: actualFilename,
        caption,
        mimeType: mimeType || resolved.mimeType,
        size: size || resolved.size,
      },
      description: `File sent: ${actualFilename}`,
    };
  },
};
