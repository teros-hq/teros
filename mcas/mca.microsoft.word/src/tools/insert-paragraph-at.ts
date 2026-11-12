import type { ToolConfig } from '@teros/mca-sdk'
import type { GraphSecrets } from '../lib'
import {
  buildParagraphXml,
  createGraphClient,
  editDocxInPlace,
  insertParagraphsAtPosition,
  itemRef,
  readPart,
  writePart,
} from '../lib';

/** insert-paragraph-at — insert paragraphs before a specific paragraph index. */
export const insertParagraphAt: ToolConfig = {
    description:
      'Insert paragraphs before a specific paragraph index in a Word document. Use beforeIndex 0 to insert at the beginning, or the paragraph count (from list-paragraphs) to append at the end. Overwrites the stored file; earlier states are recoverable only through OneDrive version history.',
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
        paragraphs: {
          type: 'array',
          description:
            'Paragraphs to insert, in order. Each is { text, style?, bold?, italic? }; style may be Heading1, Heading2, or Heading3.',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              style: { type: 'string', enum: ['Heading1', 'Heading2', 'Heading3'] },
              bold: { type: 'boolean' },
              italic: { type: 'boolean' },
            },
            required: ['text'],
          },
        },
        beforeIndex: {
          type: 'number',
          description:
            'Zero-based paragraph index to insert before, as reported by list-paragraphs. Use 0 to insert at the beginning, or the paragraph count to append at the end.',
        },
      },
      required: ['paragraphs', 'beforeIndex'],
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
      if (!Array.isArray(a.paragraphs) || a.paragraphs.length === 0) {
        throw new Error('Specify paragraphs — at least one { text } entry to insert.');
      }
      if (typeof a.beforeIndex !== 'number' || !Number.isInteger(a.beforeIndex)) {
        throw new Error('Specify beforeIndex — a whole number (0 to insert at the beginning, or the paragraph count to append at the end).');
      }
      const entries = a.paragraphs as Array<{ text?: unknown; style?: unknown; bold?: unknown; italic?: unknown }>;
      const xml = entries
        .map((entry) => {
          if (typeof entry?.text !== 'string') {
            throw new Error('Every paragraph needs a text string.');
          }
          return buildParagraphXml(
            entry.text,
            typeof entry.style === 'string' ? entry.style : undefined,
            entry.bold === true,
            entry.italic === true,
          );
        })
        .join('');

      const { uploadedBytes } = await editDocxInPlace(graphRequest, ref, async (zip) => {
        const doc = await readPart(zip, 'word/document.xml');
        writePart(zip, 'word/document.xml', insertParagraphsAtPosition(doc, xml, a.beforeIndex as number));
      });

      return { success: true, account: email, paragraphsInserted: entries.length, beforeIndex: a.beforeIndex, uploadedBytes };
    },
  }
