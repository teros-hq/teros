import type { ToolConfig } from '@teros/mca-sdk'
import type { GraphSecrets } from '../lib'
import {
  addHyperlinkRelationship,
  buildHyperlinkParagraphXml,
  createGraphClient,
  editDocxInPlace,
  insertParagraphsXml,
  itemRef,
  readPart,
  writePart,
} from '../lib';

/** insert-hyperlink — append a paragraph containing a clickable hyperlink. */
export const insertHyperlink: ToolConfig = {
    description:
      'Insert a clickable hyperlink at the end of a Word document. The link opens the given URL when clicked in Word. Overwrites the stored file; earlier states are recoverable only through OneDrive version history.',
    parameters: {
      type: 'object',
      properties: {
        itemId: {
          type: 'string',
          description: 'OneDrive item id of the .docx. Takes precedence over path.',
        },
        path: {
          type: 'string',
          description: 'Path to the .docx relative to the drive root. Pass literal names, not pre-encoded ones.',
        },
        url: {
          type: 'string',
          description: 'The URL the hyperlink opens. Must start with http:// or https://.',
        },
        displayText: {
          type: 'string',
          description: 'The visible, clickable text shown in the document.',
        },
        bold: {
          type: 'boolean',
          description: 'Render the hyperlink text in bold. Defaults to false.',
        },
        italic: {
          type: 'boolean',
          description: 'Render the hyperlink text in italic. Defaults to false.',
        },
      },
      required: ['url', 'displayText'],
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

      if (typeof a.url !== 'string' || a.url.trim() === '') {
        throw new Error('Specify url — the URL the hyperlink should open.');
      }
      const url = a.url.trim();
      if (!/^https?:\/\//i.test(url)) {
        throw new Error('url must start with http:// or https://.');
      }

      if (typeof a.displayText !== 'string' || a.displayText.trim() === '') {
        throw new Error('Specify displayText — the visible, clickable text shown in the document.');
      }

      const bold = typeof a.bold === 'boolean' ? a.bold : false;
      const italic = typeof a.italic === 'boolean' ? a.italic : false;

      let relationshipId = '';
      const { uploadedBytes } = await editDocxInPlace(graphRequest, ref, async (zip) => {
        relationshipId = await addHyperlinkRelationship(zip, url);
        const doc = await readPart(zip, 'word/document.xml');
        writePart(
          zip,
          'word/document.xml',
          insertParagraphsXml(
            doc,
            buildHyperlinkParagraphXml(relationshipId, a.displayText as string, bold, italic),
          ),
        );
      });

      return {
        success: true,
        account: email,
        url,
        displayText: a.displayText,
        relationshipId,
        uploadedBytes,
      };
    },
  }
