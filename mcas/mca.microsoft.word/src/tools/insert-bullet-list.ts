import type { ToolConfig } from '@teros/mca-sdk'
import type { GraphSecrets } from '../lib'
import {
  buildListParagraphXml,
  createGraphClient,
  editDocxInPlace,
  ensureNumberingPart,
  insertParagraphsXml,
  itemRef,
  readPart,
  writePart,
} from '../lib';

/** insert-bullet-list — append a bulleted list to the end of the body. */
export const insertBulletList: ToolConfig = {
    description:
      'Append a bulleted list to a Word document. Each item in the items array becomes a bullet point. Overwrites the stored file; earlier states are recoverable only through OneDrive version history.',
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
        items: {
          type: 'array',
          description: 'List items, in order. Each string becomes one bullet point.',
          items: { type: 'string' },
        },
      },
      required: ['items'],
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
      if (!Array.isArray(a.items) || a.items.length === 0) {
        throw new Error('Specify items — at least one string to add as a bullet point.');
      }
      const items = a.items.map((item) => String(item));

      const { uploadedBytes } = await editDocxInPlace(graphRequest, ref, async (zip) => {
        const numId = await ensureNumberingPart(zip, 'bullet');
        const doc = await readPart(zip, 'word/document.xml');
        const paragraphs = items.map((text) => buildListParagraphXml(text, numId)).join('');
        writePart(zip, 'word/document.xml', insertParagraphsXml(doc, paragraphs));
      });

      return {
        success: true,
        account: email,
        itemsWritten: items.length,
        uploadedBytes,
      };
    },
  }
