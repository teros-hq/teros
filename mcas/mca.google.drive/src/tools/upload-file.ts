import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { createReadStream, existsSync } from 'fs';
import { basename } from 'path';
import { ALL_DRIVES, ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';
import { extToMime, GOOGLE_NATIVE_MIME, type GoogleNativeTarget } from './_mime';

export const uploadFile: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Upload a local file to Google Drive. By default the file is stored as-is with its real type. Pass convertTo to import it as a native Google file (e.g. an HTML/Word file → editable Google Doc).',
  parameters: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Local path of the file to upload',
      },
      parentFolderId: {
        type: 'string',
        description: 'Optional: ID of the folder to upload to (default: root)',
      },
      fileName: {
        type: 'string',
        description: 'Optional: Custom name for the file (default: original filename)',
      },
      convertTo: {
        type: 'string',
        enum: ['document', 'spreadsheet', 'presentation'],
        description:
          'Optional: convert the upload into a native Google file. "document" (e.g. from HTML/Word/Markdown) → editable Google Doc; "spreadsheet" (from CSV/Excel) → Google Sheet; "presentation" (from PPTX) → Google Slides. Omit to keep the original format.',
      },
    },
    required: ['filePath'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { filePath, parentFolderId, fileName, convertTo } = args as {
      filePath: string;
      parentFolderId?: string;
      fileName?: string;
      convertTo?: GoogleNativeTarget;
    };

    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    if (convertTo && !(convertTo in GOOGLE_NATIVE_MIME)) {
      throw new Error(
        `Invalid convertTo "${convertTo}". Expected one of: ${Object.keys(GOOGLE_NATIVE_MIME).join(', ')}.`,
      );
    }

    const name = fileName || basename(filePath);

    return withAuthRetry(
      context,
      async () => {
        const fileMetadata: { name: string; parents?: string[]; mimeType?: string } = { name };

        if (parentFolderId) {
          fileMetadata.parents = [parentFolderId];
        }

        // Native target on the metadata = ask Drive to convert (only fires when
        // the source media.mimeType below is an importable format).
        if (convertTo) {
          fileMetadata.mimeType = GOOGLE_NATIVE_MIME[convertTo];
        }

        const media = {
          // Real Content-Type derived from the SOURCE file (filePath), not the
          // destination name: the media type must reflect the bytes being sent.
          // Using `name` broke conversion when fileName had no extension (e.g.
          // a clean title like "Informe Q3") → octet-stream → Drive can't match
          // importFormats → no native Doc. Drive needs the true source type both
          // to preview the file and to match importFormats when converting.
          mimeType: extToMime(filePath),
          body: createReadStream(filePath),
        };

        const response = await clients.drive.files.create({
          ...ALL_DRIVES,
          requestBody: fileMetadata,
          media,
          fields: 'id, name, mimeType, size, webViewLink',
        });

        return response.data;
      },
      'upload-file',
    );
  },
};
