import { Buffer } from 'node:buffer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getNotionClient } from '../lib';
// Imported via the inner module so tests that `mock.module('../lib', ...)`
// don't have to enumerate the error helper too.
import { NotionApiError } from '../lib/_notion-error';
import { validateUuid } from './_notion-helpers';
import { wrapNotionWrite } from './utils';

const DATA_URL_RE = /^data:([^;]+);base64,(.+)$/;
const MAX_FILE_SIZE_MB = 20; // Notion's documented per-file limit on the v1 API.

export const uploadFile: ToolConfig = {
  description:
    "Upload a file to Notion. Three-step lifecycle: create → send → complete (handled internally). Provide either `dataUrl` (base64 inline) or `filePath` (server-side path). Returns { fileUploadId, status, name, contentType }. The id can be embedded in subsequent block creates as { type: 'file_upload', file_upload: { id } }. Hard cap 20 MB.",
  parameters: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        description: 'Page UUID owning the upload (required).',
      },
      name: {
        type: 'string',
        description: "Filename including extension (e.g. 'spec.pdf', 'cover.png').",
      },
      contentType: {
        type: 'string',
        description: "MIME type (e.g. 'application/pdf', 'image/png').",
      },
      dataUrl: {
        type: 'string',
        description:
          'Data URI scheme — exact format `data:<mime>;base64,<base64Payload>`. NOT a raw base64 string. Either this or filePath is required.',
      },
      filePath: {
        type: 'string',
        description: 'Absolute path to a server-side file. Either this or dataUrl is required.',
      },
    },
    required: ['pageId', 'name', 'contentType'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'experimental' },
  handler: async (args, context) => {
    const client = await getNotionClient(context);
    const { pageId, name, contentType, dataUrl, filePath } = args as {
      pageId: string;
      name: string;
      contentType: string;
      dataUrl?: string;
      filePath?: string;
    };
    validateUuid(pageId, 'pageId');
    if (!name || typeof name !== 'string') throw new Error('name is required.');
    if (!contentType || typeof contentType !== 'string') {
      throw new Error('contentType is required (e.g. "application/pdf").');
    }
    if (!dataUrl && !filePath) {
      throw new Error('Either dataUrl or filePath is required.');
    }
    if (dataUrl && filePath) {
      throw new Error('Pass only one of dataUrl / filePath.');
    }

    let buffer: Buffer;
    if (dataUrl) {
      const m = DATA_URL_RE.exec(dataUrl);
      if (!m) throw new Error('dataUrl must be of shape "data:<mime>;base64,<payload>".');
      buffer = Buffer.from(m[2], 'base64');
    } else {
      const resolved = path.resolve(filePath as string);
      buffer = await fs.readFile(resolved);
    }

    const sizeMb = buffer.byteLength / (1024 * 1024);
    if (sizeMb > MAX_FILE_SIZE_MB) {
      throw new Error(`File too large (${sizeMb.toFixed(2)} MB > ${MAX_FILE_SIZE_MB} MB cap).`);
    }

    // Step 1 — create the upload slot.
    const created: any = await wrapNotionWrite(() =>
      (client as any).fileUploads.create({
        parent: { type: 'page_id', page_id: pageId },
        name,
        content_type: contentType,
      }),
    );

    // Step 2 — send the bytes. v5 SDK serialises the request as multipart/form-data
    // and `file.data` must be a Blob (or string). A raw Node Buffer fails with
    // "FormData append parameter 2 is not of type 'Blob'" because Node 18+
    // FormData rejects ArrayBufferView. Wrap the Buffer in a Blob so it travels
    // identically from the stdio host and the Docker container.
    const blob = new Blob([buffer], { type: contentType });
    const sent: any = await wrapNotionWrite(() =>
      (client as any).fileUploads.send({
        file_upload_id: created.id,
        file: { data: blob, filename: name },
      }),
    );

    // Step 3 — finalise. For single-part uploads (the only kind we drive
    // here), Notion v5 already transitions the upload to `uploaded` status
    // when `send` returns; calling `complete` then 4xxs with
    // "File uploads must be in a 'pending' status to use the complete API".
    // Multi-part uploads (which we don't yet support) DO need an explicit
    // complete after all parts. Skip the call when the upload is already
    // finished, retry once on validation_error if Notion's server still
    // requires it for older API versions.
    let finalStatus: string = sent?.status ?? 'uploaded';
    if (finalStatus === 'pending') {
      try {
        const completed: any = await wrapNotionWrite(() =>
          (client as any).fileUploads.complete({
            file_upload_id: created.id,
          }),
        );
        finalStatus = completed.status ?? 'uploaded';
      } catch (err) {
        // Coerce the "already uploaded" race into success — the file is
        // already attached on Notion's side, the agent gets the id back.
        // The throw is normalised to NotionApiError VALIDATION_ERROR by
        // wrapNotionWrite; the upstream message is preserved verbatim.
        const isPendingStatusRace =
          err instanceof NotionApiError &&
          err.classified.code === 'VALIDATION_ERROR' &&
          /'pending'\s*status/i.test(err.upstreamMessage);
        if (isPendingStatusRace) {
          finalStatus = 'uploaded';
        } else {
          throw err;
        }
      }
    }

    return {
      fileUploadId: created.id,
      status: finalStatus,
      name,
      contentType,
      sizeBytes: buffer.byteLength,
    };
  },
};
