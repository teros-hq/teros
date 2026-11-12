import type { ToolConfig } from '@teros/mca-sdk'
import type { GraphSecrets } from '../lib'
import {
  buildTableXml,
  createGraphClient,
  editDocxInPlace,
  insertParagraphsXml,
  itemRef,
  readPart,
  writePart,
} from '../lib';

/** insert-table — append a bordered table to the end of the body. */
export const insertTable: ToolConfig = {
    description:
      'Append a table to a Word document. Rows are plain strings; the first can be styled as a header. Overwrites the stored file; earlier states are recoverable only through OneDrive version history.',
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
        rows: {
          type: 'array',
          description:
            'Table contents as an array of rows, each an array of cell strings. Every row must have the same number of cells.',
          items: { type: 'array', items: { type: 'string' } },
        },
        headerRow: {
          type: 'boolean',
          description: 'Render the first row in bold as a header. Defaults to false.',
        },
      },
      required: ['rows'],
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
      if (!Array.isArray(a.rows) || a.rows.length === 0) {
        throw new Error('Specify rows — at least one row of cell strings.');
      }
      const rows = a.rows as unknown[];
      if (!rows.every((row) => Array.isArray(row))) {
        throw new Error('Each row must be an array of cell strings.');
      }
      const width = (rows[0] as unknown[]).length;
      if (width === 0) throw new Error('Each row must have at least one cell.');
      // A ragged table is invalid OOXML and Word refuses to open the file, so
      // this has to fail here rather than after the upload.
      if (!rows.every((row) => (row as unknown[]).length === width)) {
        throw new Error('Every row must have the same number of cells.');
      }
      const cells = rows.map((row) => (row as unknown[]).map((cell) => String(cell)));

      const { uploadedBytes } = await editDocxInPlace(graphRequest, ref, async (zip) => {
        const doc = await readPart(zip, 'word/document.xml');
        const table = buildTableXml(cells, a.headerRow === true);
        writePart(zip, 'word/document.xml', insertParagraphsXml(doc, table));
      });

      return {
        success: true,
        account: email,
        rowsWritten: cells.length,
        columns: width,
        uploadedBytes,
      };
    },
  }
