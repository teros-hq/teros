import type { ToolConfig } from '@teros/mca-sdk';
import { brevoRequest } from '../lib/brevo-client';
import { buildCreateListBody, validateCreateListArgs } from './_helpers';

interface CreateListResponse {
  id?: number;
}

/**
 * create-list — POST /contacts/lists.
 *
 * Both `name` and `folderId` are required by Brevo — a list always lives inside
 * a folder. Returns DATA (id + echoed name/folderId); the renderer composes the
 * "created" sentence. Reversible (the list can be deleted), so not marked
 * irreversible/destructive.
 */
export const createList: ToolConfig = {
  description:
    'Create a contact list in Brevo (POST /contacts/lists). Returns { id, name, folderId }. Lists live inside a folder — pass a folderId (call list-folders to find one). Params: name (required), folderId (required, integer).',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name of the new list (required).' },
      folderId: {
        type: 'number',
        description: 'Id of the parent folder (required). Use list-folders to find one.',
      },
    },
    required: ['name', 'folderId'],
  },
  annotations: {
    readOnlyHint: false,
    version: '1.0.0',
    stability: 'stable',
    openWorldHint: true,
    idempotentHint: false,
  },
  handler: async (args, context) => {
    validateCreateListArgs(args);
    const body = buildCreateListBody(args as Record<string, unknown>);

    const res = await brevoRequest<CreateListResponse>(context, '/contacts/lists', {
      method: 'POST',
      body,
    });

    return {
      id: typeof res?.id === 'number' ? res.id : null,
      name: body.name,
      folderId: body.folderId,
    };
  },
};
