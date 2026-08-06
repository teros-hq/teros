import type { ToolConfig } from '@teros/mca-sdk';
import { brevoRequest } from '../lib/brevo-client';
import { buildImportContactsBody, validateImportContactsArgs } from './_helpers';

interface ImportContactsResponse {
  processId?: number;
}

/**
 * import-contacts — POST /contacts/import.
 *
 * Bulk-import contacts into one or more lists, EITHER inline (`jsonBody`) OR
 * from a remote file (`fileUrl`). Brevo runs the import asynchronously and
 * returns a `processId` you can poll with the process endpoints. Reversible
 * (contacts can be deleted), so NOT marked irreversible/destructive.
 */
export const importContacts: ToolConfig = {
  description:
    'Bulk-import contacts into Brevo lists (POST /contacts/import). Provide EITHER jsonBody[] (inline contacts) OR fileUrl (a .csv/.json/.txt file), never both. Runs asynchronously — returns { processId, listIds, contactCount, source }. Params: jsonBody? ([{ email (required), attributes? }]), fileUrl? (http(s) URL), listIds (required, integer[] — the target lists), updateExistingContacts? (default false — update contacts that already exist instead of skipping them).',
  parameters: {
    type: 'object',
    properties: {
      jsonBody: {
        type: 'array',
        description: 'Inline contacts to import (mutually exclusive with fileUrl).',
        items: {
          type: 'object',
          properties: {
            email: { type: 'string', description: 'Contact email address (required).' },
            attributes: {
              type: 'object',
              description: 'Contact attributes keyed by Brevo attribute name (e.g. { FIRSTNAME, LASTNAME }).',
            },
          },
          required: ['email'],
        },
      },
      fileUrl: {
        type: 'string',
        description: 'Public http(s) URL of a .csv/.json/.txt file to import (mutually exclusive with jsonBody).',
      },
      listIds: {
        type: 'array',
        description: 'Ids of the lists the contacts are imported into (required, at least one).',
        items: { type: 'number' },
      },
      updateExistingContacts: {
        type: 'boolean',
        description: 'If true, update contacts that already exist instead of skipping them (default false).',
        default: false,
      },
    },
    required: ['listIds'],
  },
  annotations: {
    readOnlyHint: false,
    version: '1.0.0',
    stability: 'stable',
    openWorldHint: true,
    idempotentHint: false,
  },
  handler: async (args, context) => {
    validateImportContactsArgs(args);
    const body = buildImportContactsBody(args as Record<string, unknown>);

    const res = await brevoRequest<ImportContactsResponse>(context, '/contacts/import', {
      method: 'POST',
      body,
    });

    return {
      processId: typeof res.processId === 'number' ? res.processId : null,
      listIds: body.listIds,
      contactCount: body.jsonBody ? body.jsonBody.length : null,
      source: body.jsonBody ? 'inline' : 'file',
    };
  },
};
