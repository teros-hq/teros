import type { ToolConfig } from '@teros/mca-sdk';
import { brevoRequest } from '../lib/brevo-client';
import { buildUpdateContactBody, validateContactIdentifier, validateUpdateContactArgs } from './_helpers';

/**
 * update-contact — PUT /contacts/{identifier}.
 *
 * Updates attributes, blacklist flags and list membership (`listIds` adds,
 * `unlinkListIds` removes). Brevo returns 204. Reversible, so not marked
 * irreversible/destructive.
 */
export const updateContact: ToolConfig = {
  description:
    'Update a contact in Brevo (PUT /contacts/{identifier}). Returns { identifier, updated, listIds, unlinkListIds }. Attributes must already exist in the account (pass them UPPERCASE). listIds adds the contact to lists, unlinkListIds removes it. Params: identifier (required — email or id), attributes? (e.g. { FIRSTNAME }), emailBlacklisted?, smsBlacklisted?, listIds? (number[]), unlinkListIds? (number[]).',
  parameters: {
    type: 'object',
    properties: {
      identifier: {
        type: 'string',
        description: 'The contact email or numeric id to update (required).',
      },
      attributes: {
        type: 'object',
        description: 'Attributes to set (must already exist in the account, UPPERCASE, e.g. { FIRSTNAME, LASTNAME }).',
      },
      emailBlacklisted: {
        type: 'boolean',
        description: 'Blacklist (true) or allow (false) the contact for emails.',
      },
      smsBlacklisted: {
        type: 'boolean',
        description: 'Blacklist (true) or allow (false) the contact for SMS.',
      },
      listIds: {
        type: 'array',
        description: 'List ids to add the contact to.',
        items: { type: 'number' },
      },
      unlinkListIds: {
        type: 'array',
        description: 'List ids to remove the contact from.',
        items: { type: 'number' },
      },
    },
    required: ['identifier'],
  },
  annotations: {
    readOnlyHint: false,
    version: '1.0.0',
    stability: 'stable',
    openWorldHint: true,
    idempotentHint: false,
  },
  handler: async (args, context) => {
    validateUpdateContactArgs(args);
    const a = args as Record<string, unknown>;
    const identifier = validateContactIdentifier(a.identifier);
    const body = buildUpdateContactBody(a);

    await brevoRequest<unknown>(context, `/contacts/${encodeURIComponent(identifier)}`, {
      method: 'PUT',
      body,
    });

    return {
      identifier,
      updated: true,
      listIds: body.listIds ?? [],
      unlinkListIds: body.unlinkListIds ?? [],
    };
  },
};
