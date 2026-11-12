import type { ToolConfig } from '@teros/mca-sdk'
import type { GraphSecrets } from '../lib'
import {
  createGraphClient,
  editDocxInPlace,
  itemRef,
  readPart,
  setCoreProperty,
  writePart,
} from '../lib';

/** The document properties Word shows in File → Info, and their XML tags. */
const PROPERTY_TAGS: Record<string, string> = {
  title: 'dc:title',
  creator: 'dc:creator',
  subject: 'dc:subject',
  description: 'dc:description',
};

/** update-document-properties — edit docProps/core.xml and nothing else. */
export const updateDocumentProperties: ToolConfig = {
    description:
      "Set a Word document's title, author, subject, or description — the properties Word shows in File → Info. Leaves the document body untouched. Overwrites the stored file; earlier states are recoverable only through OneDrive version history.",
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
        title: { type: 'string', description: 'Document title.' },
        creator: { type: 'string', description: 'Document author.' },
        subject: { type: 'string', description: 'Document subject.' },
        description: { type: 'string', description: 'Document description or comments.' },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    handler: async (args, context) => {
      const secrets = { ...(await context.getSystemSecrets()), ...(await context.getUserSecrets()) } as GraphSecrets
      const { graphRequest, email } = await createGraphClient(secrets, context.updateUserSecrets?.bind(context), 'Word', 'Files.ReadWrite.All');

      const a = (args ?? {}) as Record<string, unknown>;
      const ref = itemRef(a);
      const updates = Object.keys(PROPERTY_TAGS).filter((key) => typeof a[key] === 'string');
      if (updates.length === 0) {
        throw new Error(
          'Specify at least one of title, creator, subject, or description — there is nothing to change otherwise.',
        );
      }

      const { uploadedBytes } = await editDocxInPlace(graphRequest, ref, async (zip) => {
        let core = await readPart(zip, 'docProps/core.xml');
        for (const key of updates) {
          core = setCoreProperty(core, PROPERTY_TAGS[key], a[key] as string);
        }
        writePart(zip, 'docProps/core.xml', core);
      });

      return { success: true, account: email, updated: updates, uploadedBytes };
    },
  }
