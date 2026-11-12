import type { ToolConfig } from '@teros/mca-sdk'
import type { GraphSecrets } from '../lib'
import { buildDocx, type ParagraphContent } from '../lib/build-docx';
import {
  assertDocxName,
  createGraphClient,
  DOCX_CONTENT_TYPE,
  encodePathSegments,
  formatItem,
  validateDocx,
} from '../lib';

/** create-document — PUT a freshly synthesized .docx to a drive path. */
export const createDocument: ToolConfig = {
    description:
      'Create a new Word document from structured paragraphs. Fails if a file already exists at the path unless overwrite is set — an existing document is not recoverable from here except through OneDrive version history.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Destination path relative to the drive root, ending in .docx. Pass literal names, not pre-encoded ones.',
        },
        paragraphs: {
          type: 'array',
          description:
            'The document body, in order. Each entry is { text, style?, bold?, italic? }; style may be Heading1, Heading2, or Heading3.',
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
        title: { type: 'string', description: 'Optional document title property.' },
        creator: { type: 'string', description: 'Optional document author property.' },
        overwrite: {
          type: 'boolean',
          description:
            'Replace an existing file at this path. Defaults to false, which fails instead.',
        },
      },
      required: ['path', 'paragraphs'],
    },
    annotations: {
      readOnlyHint: false,
      // Spec §7.5: every mutating tool in this app is destructive. With
      // overwrite set this replaces a stored file outright.
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (args, context) => {
      const secrets = { ...(await context.getSystemSecrets()), ...(await context.getUserSecrets()) } as GraphSecrets
      const { graphRequest, email } = await createGraphClient(secrets, context.updateUserSecrets?.bind(context), 'Word', 'Files.ReadWrite.All');

      const a = (args ?? {}) as Record<string, unknown>;
      if (typeof a.path !== 'string' || a.path.trim() === '') {
        throw new Error('Specify path — where to create the document, ending in .docx.');
      }
      assertDocxName(a.path);
      if (!Array.isArray(a.paragraphs) || a.paragraphs.length === 0) {
        throw new Error('Specify paragraphs — at least one { text } entry to put in the document.');
      }
      // Validate each entry, not just the array. `docx` accepts a missing or
      // non-string `text` without complaint and emits a document with the text
      // silently dropped — so an agent that typo'd a key would get
      // `success: true` over a document missing its content. (A `null` text
      // does throw, but from inside the library, with a message an agent
      // cannot act on.) `append-paragraphs` validates the same shape.
      const entries = a.paragraphs as Array<{ text?: unknown; style?: unknown }>;
      entries.forEach((entry, index) => {
        if (typeof entry?.text !== 'string' || entry.text === '') {
          throw new Error(
            `Paragraph ${index} needs a non-empty text string; got ${JSON.stringify(entry?.text)}.`,
          );
        }
      });

      const bytes = await buildDocx({
        title: typeof a.title === 'string' ? a.title : undefined,
        creator: typeof a.creator === 'string' ? a.creator : undefined,
        paragraphs: entries as ParagraphContent[],
      });

      // Spec §8.3: validate before every upload. This is the only upload path
      // that synthesizes its own document.xml rather than editing an existing
      // one, but the same "successfully uploaded, subtly corrupted file" risk
      // applies to it.
      await validateDocx(bytes);

      // Default to failing rather than replacing. A create that silently
      // overwrites turns an agent's retry into data loss.
      const conflict = a.overwrite === true ? 'replace' : 'fail';
      const created = await graphRequest<Record<string, any>>(
        'PUT',
        `/me/drive/root:/${encodePathSegments(a.path)}:/content?@microsoft.graph.conflictBehavior=${conflict}`,
        undefined,
        { rawBody: bytes, headers: { 'Content-Type': DOCX_CONTENT_TYPE } },
      );

      return {
        success: true,
        account: email,
        item: formatItem(created),
        paragraphsWritten: (a.paragraphs as unknown[]).length,
      };
    },
  }
