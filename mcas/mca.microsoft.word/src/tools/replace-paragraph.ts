import type { ToolConfig } from '@teros/mca-sdk'
import type { GraphSecrets } from '../lib'
import {
  buildParagraphXml,
  createGraphClient,
  editDocxInPlace,
  itemRef,
  readPart,
  replaceParagraph,
  writePart,
} from '../lib';

/** replace-paragraph — replace the content of paragraph N in-place. */
export const replaceParagraphTool: ToolConfig = {
    description:
      'Replace the content of paragraph N in a Word document, preserving its position. Other paragraphs are unaffected — their indices do not change. Supports style, bold, and italic on the replacement. Overwrites the stored file; earlier states are recoverable only through OneDrive version history.',
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
        paragraphIndex: {
          type: 'number',
          description: 'Zero-based paragraph index, as reported by list-paragraphs.',
        },
        text: {
          type: 'string',
          description: 'New paragraph text.',
        },
        style: {
          type: 'string',
          enum: ['Heading1', 'Heading2', 'Heading3'],
          description: 'Optional heading style for the replacement paragraph.',
        },
        bold: {
          type: 'boolean',
          description: 'If true, the replacement paragraph text is bold.',
        },
        italic: {
          type: 'boolean',
          description: 'If true, the replacement paragraph text is italic.',
        },
      },
      required: ['paragraphIndex', 'text'],
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
      // A destructive tool never guesses its target. Nothing validates
      // arguments before the handler runs, so an absent index would otherwise
      // become NaN and replace whatever that resolves to.
      if (typeof a.paragraphIndex !== 'number' || !Number.isInteger(a.paragraphIndex) || a.paragraphIndex < 0) {
        throw new Error('Specify paragraphIndex — a non-negative whole number from list-paragraphs.');
      }
      if (typeof a.text !== 'string') {
        throw new Error('Specify text — the new paragraph content as a string.');
      }

      const newXml = buildParagraphXml(
        a.text,
        typeof a.style === 'string' ? a.style : undefined,
        a.bold === true,
        a.italic === true,
      );

      const { uploadedBytes } = await editDocxInPlace(graphRequest, ref, async (zip) => {
        const doc = await readPart(zip, 'word/document.xml');
        writePart(zip, 'word/document.xml', replaceParagraph(doc, a.paragraphIndex as number, newXml));
      });

      return { success: true, account: email, replacedIndex: a.paragraphIndex, uploadedBytes };
    },
  }
