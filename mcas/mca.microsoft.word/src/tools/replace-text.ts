import type { ToolConfig } from '@teros/mca-sdk'
import type { GraphSecrets } from '../lib'
import {
  createGraphClient,
  editDocxInPlace,
  itemAction,
  itemRef,
  openDocx,
  readPart,
  replaceTextInDocument,
  writePart,
} from '../lib';

/** replace-text — find and replace across run boundaries. */
export const replaceText: ToolConfig = {
    description:
      'Replace text in a Word document, matching text as the reader sees it even when Word has split it across formatting runs. Text inside tables is not searched or replaced. Overwrites the stored file; earlier states are recoverable only through OneDrive version history.',
    parameters: {
      type: 'object',
      properties: {
        itemId: {
          type: 'string',
          description: 'OneDrive item id of the .docx. Takes precedence over path.',
        },
        path: {
          type: 'string',
          description:
            'Path to the .docx relative to the drive root. Pass literal names, not pre-encoded ones.',
        },
        search: { type: 'string', description: 'Exact text to find. Not a regular expression.' },
        replacement: {
          type: 'string',
          description: 'Text to put in its place. May be empty to delete.',
        },
        paragraphIndex: {
          type: 'number',
          description:
            'Optional paragraph index from list-paragraphs. Omit to replace throughout the document.',
        },
      },
      required: ['search', 'replacement'],
    },
    annotations: {
      readOnlyHint: false,
      // Spec §7.5: every mutation here is a read-modify-write that overwrites
      // the stored file, and the app cannot undo it.
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (args, context) => {
      const secrets = { ...(await context.getSystemSecrets()), ...(await context.getUserSecrets()) } as GraphSecrets
      const { graphRequest, email } = await createGraphClient(secrets, context.updateUserSecrets?.bind(context), 'Word', 'Files.ReadWrite.All');

      const a = (args ?? {}) as Record<string, unknown>;
      const ref = itemRef(a);
      if (typeof a.search !== 'string' || a.search === '') {
        throw new Error('Specify search — the exact text to find. It cannot be empty.');
      }
      const replacement = typeof a.replacement === 'string' ? a.replacement : '';
      if (a.paragraphIndex !== undefined && !Number.isInteger(a.paragraphIndex)) {
        throw new Error('paragraphIndex must be a whole number from list-paragraphs.');
      }
      const paragraphIndex = typeof a.paragraphIndex === 'number' ? a.paragraphIndex : undefined;

      let replacements = 0;
      // Peek before committing: a no-op edit should not rewrite the stored
      // file, because every upload costs a version and this tool is
      // destructive by definition.
      const original = await graphRequest<Buffer>('GET', itemAction(ref, '/content'), undefined, {
        responseType: 'buffer',
      });
      const originalDoc = await readPart(
        await openDocx(Buffer.from(original)),
        'word/document.xml',
      );
      const preview = replaceTextInDocument(originalDoc, a.search, replacement, paragraphIndex);

      // `replaceTextInDocument` walks `paragraphRanges`, which excludes table
      // content by design (spec §2.1's bounded edit surface): a table cell's
      // `<w:p>` is not addressable as a document paragraph. That means a
      // global replace can report success while a matching table cell is left
      // untouched, with nothing else in the result saying so. `list-paragraphs`
      // and `delete-paragraph` already say this in their descriptions; this
      // note is the runtime version of the same caveat.
      const tableCaveat = originalDoc.includes('<w:tbl')
        ? 'This document contains a table; text inside table cells was not searched or replaced.'
        : undefined;

      if (preview.count === 0) {
        const notFound = 'That text was not found, so the document was left untouched.';
        return {
          success: true,
          account: email,
          replacements: 0,
          note: tableCaveat ? `${notFound} ${tableCaveat}` : notFound,
        };
      }

      const { uploadedBytes } = await editDocxInPlace(graphRequest, ref, async (zip) => {
        const doc = await readPart(zip, 'word/document.xml');
        const result = replaceTextInDocument(doc, a.search as string, replacement, paragraphIndex);
        replacements = result.count;
        writePart(zip, 'word/document.xml', result.xml);
      });

      return {
        success: true,
        account: email,
        replacements,
        uploadedBytes,
        ...(tableCaveat ? { note: tableCaveat } : {}),
      };
    },
  }
