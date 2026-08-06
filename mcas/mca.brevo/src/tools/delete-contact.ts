import type { ToolConfig } from '@teros/mca-sdk';
import { brevoRequest } from '../lib/brevo-client';
import { validateContactIdentifier } from './_helpers';

/**
 * delete-contact — DELETE /contacts/{identifier}.
 *
 * Permanently deletes the contact. IRREVERSIBLE + destructive → excluded from
 * grouped "Allow all". No request body (the client omits Content-Type on
 * body-less requests, avoiding Brevo's empty-body rejection).
 */
export const deleteContact: ToolConfig = {
  description:
    'Delete a contact permanently from Brevo (DELETE /contacts/{identifier}). IRREVERSIBLE — the contact and its history are removed. Returns { identifier, deleted }. Params: identifier (required — the contact email or id).',
  parameters: {
    type: 'object',
    properties: {
      identifier: {
        type: 'string',
        description: 'The contact email or numeric id to delete (required).',
      },
    },
    required: ['identifier'],
  },
  annotations: {
    readOnlyHint: false,
    version: '1.0.0',
    stability: 'stable',
    destructiveHint: true,
    openWorldHint: true,
    idempotentHint: true,
  },
  handler: async (args, context) => {
    const identifier = validateContactIdentifier((args as Record<string, unknown>)?.identifier);
    await brevoRequest<unknown>(context, `/contacts/${encodeURIComponent(identifier)}`, {
      method: 'DELETE',
    });
    return { identifier, deleted: true };
  },
};
