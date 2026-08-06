import type { ToolConfig } from '@teros/mca-sdk';
import { brevoRequest } from '../lib/brevo-client';
import { shapeContact, validateContactIdentifier } from './_helpers';

/**
 * get-contact — GET /contacts/{identifier}.
 *
 * `identifier` is an email or a numeric contact id (or EXT_ID). It is
 * URL-encoded into the path.
 */
export const getContact: ToolConfig = {
  description:
    'Get one contact by email or id from Brevo (GET /contacts/{identifier}). Returns { id, email, emailBlacklisted, smsBlacklisted, listIds, attributes, createdAt, modifiedAt }. Params: identifier (required — the contact email or id).',
  parameters: {
    type: 'object',
    properties: {
      identifier: {
        type: 'string',
        description: 'The contact email or numeric id (required).',
      },
    },
    required: ['identifier'],
  },
  annotations: {
    version: '1.0.0',
    stability: 'stable',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args, context) => {
    const identifier = validateContactIdentifier((args as Record<string, unknown>)?.identifier);
    const res = await brevoRequest<unknown>(context, `/contacts/${encodeURIComponent(identifier)}`);
    return shapeContact(res);
  },
};
