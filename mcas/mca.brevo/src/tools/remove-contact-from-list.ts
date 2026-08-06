import type { ToolConfig } from '@teros/mca-sdk';
import { brevoRequest } from '../lib/brevo-client';
import { buildMembershipBody, coerceInt, shapeMembershipResult, validateMembershipArgs } from './_helpers';

/**
 * remove-contact-from-list — POST /contacts/lists/{listId}/contacts/remove.
 *
 * Identify contacts by emails[] and/or ids[]. Reversible with
 * add-contact-to-list, so not marked irreversible/destructive.
 */
export const removeContactFromList: ToolConfig = {
  description:
    'Remove contacts from a Brevo list (POST /contacts/lists/{listId}/contacts/remove). Identify contacts by emails[] and/or ids[]. Returns { listId, success, failure } (contacts that were / were not removed). Params: listId (required, integer), emails? (string[]), ids? (number[]).',
  parameters: {
    type: 'object',
    properties: {
      listId: { type: 'number', description: 'Id of the list (required).' },
      emails: {
        type: 'array',
        description: 'Contact emails to remove.',
        items: { type: 'string' },
      },
      ids: {
        type: 'array',
        description: 'Contact ids to remove.',
        items: { type: 'number' },
      },
    },
    required: ['listId'],
  },
  annotations: {
    readOnlyHint: false,
    version: '1.0.0',
    stability: 'stable',
    openWorldHint: true,
    idempotentHint: false,
  },
  handler: async (args, context) => {
    validateMembershipArgs(args);
    const a = args as Record<string, unknown>;
    const listId = coerceInt(a.listId) as number;
    const body = buildMembershipBody(a);

    const res = await brevoRequest<unknown>(context, `/contacts/lists/${listId}/contacts/remove`, {
      method: 'POST',
      body,
    });

    return { listId, ...shapeMembershipResult(res) };
  },
};
