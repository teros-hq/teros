import type { ToolConfig } from '@teros/mca-sdk'
import type { GraphSecrets } from '../lib'
import {
  addImagePart,
  buildImageParagraphXml,
  createGraphClient,
  editDocxInPlace,
  insertParagraphsXml,
  itemRef,
  MAX_DOCX_BYTES,
  nextDrawingId,
  readPart,
  writePart,
} from '../lib';

/** English Metric Units per inch — the unit OOXML measures drawings in. */
const EMU_PER_INCH = 914400;

/** insert-image — embed a PNG or JPEG as an inline drawing. */
export const insertImage: ToolConfig = {
    description:
      'Embed a PNG or JPEG image at the end of a Word document. Overwrites the stored file; earlier states are recoverable only through OneDrive version history.',
    parameters: {
      type: 'object',
      properties: {
        itemId: {
          type: 'string',
          description: 'OneDrive item id of the .docx. Takes precedence over path.',
        },
        path: {
          type: 'string',
          description: 'Path to the .docx relative to the drive root. Pass literal names.',
        },
        imageBase64: {
          type: 'string',
          description: 'The image bytes, base64-encoded. PNG or JPEG.',
        },
        fileName: {
          type: 'string',
          description:
            'Name to store the image under inside the document, e.g. "chart.png". No directory separators.',
        },
        widthInches: { type: 'number', description: 'Displayed width in inches. Defaults to 3.' },
        heightInches: { type: 'number', description: 'Displayed height in inches. Defaults to 2.' },
      },
      required: ['imageBase64', 'fileName'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (args, context) => {
      const secrets = { ...(await context.getSystemSecrets()), ...(await context.getUserSecrets()) } as GraphSecrets
      const { graphRequest, email } = await createGraphClient(secrets, context.updateUserSecrets?.bind(context), 'Word', 'Files.ReadWrite.All');

      const a = (args ?? {}) as Record<string, unknown>;
      const ref = itemRef(a);
      if (typeof a.imageBase64 !== 'string' || a.imageBase64.trim() === '') {
        throw new Error('Specify imageBase64 — the image bytes, base64-encoded.');
      }
      if (typeof a.fileName !== 'string' || a.fileName.trim() === '') {
        throw new Error('Specify fileName — what to call the image inside the document.');
      }
      // The name becomes a zip entry path. A separator or a traversal segment
      // would write the part somewhere other than word/media.
      if (/[\\/]|\.\./.test(a.fileName)) {
        throw new Error('fileName must be a plain file name, with no directory separators.');
      }

      const bytes = Buffer.from(a.imageBase64, 'base64');
      if (bytes.length === 0) throw new Error('imageBase64 did not decode to any bytes.');
      if (bytes.length > MAX_DOCX_BYTES) {
        throw new Error(
          `That image is ${Math.round(bytes.length / 1024 / 1024)} MB, above the 50 MB limit these tools can hold in memory.`,
        );
      }

      const width = Math.round(
        (typeof a.widthInches === 'number' ? a.widthInches : 3) * EMU_PER_INCH,
      );
      const height = Math.round(
        (typeof a.heightInches === 'number' ? a.heightInches : 2) * EMU_PER_INCH,
      );

      let relationshipId = '';
      const { uploadedBytes } = await editDocxInPlace(graphRequest, ref, async (zip) => {
        // Three of the four coordinated edits happen here; the fourth is the
        // drawing itself, below. Any one missing and Word calls the file corrupt.
        const added = await addImagePart(zip, a.fileName as string, bytes);
        relationshipId = added.relationshipId;
        const doc = await readPart(zip, 'word/document.xml');
        writePart(
          zip,
          'word/document.xml',
          insertParagraphsXml(
            doc,
            buildImageParagraphXml(relationshipId, width, height, nextDrawingId(doc)),
          ),
        );
      });

      return {
        success: true,
        account: email,
        fileName: a.fileName,
        relationshipId,
        imageBytes: bytes.length,
        uploadedBytes,
      };
    },
  }
