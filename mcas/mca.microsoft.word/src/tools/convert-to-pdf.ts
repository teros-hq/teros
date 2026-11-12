import type { ToolConfig } from '@teros/mca-sdk'
import type { GraphSecrets } from '../lib'
import {
  assertDocxName,
  createGraphClient,
  encodePathSegments,
  formatItem,
  itemAction,
  itemRef,
} from '../lib';

/** Swaps a .docx path's extension for .pdf. */
function derivePdfPath(docxPath: string): string {
  return docxPath.replace(/\.docx$/i, '.pdf');
}

/** convert-to-pdf — Graph converts on read; this stores the result. */
export const convertToPdf: ToolConfig = {
    description:
      'Convert a Word document to PDF and save it to OneDrive. Fails if a file already exists at the destination unless overwrite is set.',
    parameters: {
      type: 'object',
      properties: {
        itemId: {
          type: 'string',
          description:
            'OneDrive item id of the .docx. Takes precedence over path, but requires destinationPath since there is no name to derive one from.',
        },
        path: {
          type: 'string',
          description:
            'Path to the .docx relative to the drive root. Pass literal names, not pre-encoded ones.',
        },
        destinationPath: {
          type: 'string',
          description:
            'Where to save the PDF. Defaults to the source path with its extension changed to .pdf.',
        },
        overwrite: {
          type: 'boolean',
          description:
            'Replace an existing file at the destination. Defaults to false, which fails.',
        },
      },
    },
    annotations: {
      readOnlyHint: false,
      // Spec §7.5: every mutating tool in this app is destructive. This one
      // writes a new file rather than overwriting through read-modify-write,
      // and defaults to failing on a conflict — but the rule is written as
      // every mutating tool, and a wrong `false` here is the worse error.
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (args, context) => {
      const secrets = { ...(await context.getSystemSecrets()), ...(await context.getUserSecrets()) } as GraphSecrets
      const { graphRequest, email } = await createGraphClient(secrets, context.updateUserSecrets?.bind(context), 'Word', 'Files.ReadWrite.All');

      const a = (args ?? {}) as Record<string, unknown>;
      const ref = itemRef(a);

      const explicit = typeof a.destinationPath === 'string' ? a.destinationPath.trim() : '';
      const source = typeof a.path === 'string' ? a.path.trim() : '';
      // `derivePdfPath` only strips a trailing .docx; on any other extension it
      // returns the path unchanged, so { path: 'notes.txt', overwrite: true }
      // would derive 'notes.txt' as the destination and overwrite the source
      // with its own PDF conversion. Refusing a non-.docx source up front closes
      // that off with the same actionable message create-document already uses.
      if (source) assertDocxName(source);
      const destination = explicit || (source ? derivePdfPath(source) : '');
      if (!destination) {
        throw new Error(
          'Specify destinationPath — with only itemId given there is no source name to derive the PDF path from.',
        );
      }

      const pdf = await graphRequest<Buffer>(
        'GET',
        itemAction(ref, '/content?format=pdf'),
        undefined,
        {
          responseType: 'buffer',
        },
      );
      const bytes = Buffer.from(pdf);

      const conflict = a.overwrite === true ? 'replace' : 'fail';
      const saved = await graphRequest<Record<string, any>>(
        'PUT',
        `/me/drive/root:/${encodePathSegments(destination)}:/content?@microsoft.graph.conflictBehavior=${conflict}`,
        undefined,
        { rawBody: bytes, headers: { 'Content-Type': 'application/pdf' } },
      );

      return {
        success: true,
        account: email,
        item: formatItem(saved),
        destinationPath: destination,
        pdfBytes: bytes.length,
      };
    },
  }
