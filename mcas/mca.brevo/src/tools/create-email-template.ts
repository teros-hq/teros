import type { ToolConfig } from '@teros/mca-sdk';
import { brevoRequest } from '../lib/brevo-client';
import { buildCreateTemplateBody, validateCreateTemplateArgs } from './_helpers';

interface CreateTemplateResponse {
  id?: number;
}

/**
 * create-email-template — POST /smtp/templates.
 *
 * Creates a transactional email template. Templates are INACTIVE by default
 * (Brevo behaviour) — pass isActive:true to enable. `sender` is either a
 * verified { email } OR a Brevo sender { id }, never both. `templateName` is
 * the REST field name (NOT `name`) — verified against getbrevo/brevo-node
 * `CreateSmtpTemplateRequest`. Reversible (the template can be deleted), so not
 * marked irreversible/destructive.
 */
export const createEmailTemplate: ToolConfig = {
  description:
    'Create a transactional email template in Brevo (POST /smtp/templates). Returns { id, templateName, subject, isActive }. Templates are INACTIVE by default — set isActive:true to enable. sender takes EITHER {email} (a verified sender) OR {id} (a Brevo sender id), not both. Provide htmlContent (≥10 chars) or htmlUrl. Params: templateName (required), subject (required), sender{email?,id?,name?} (required), htmlContent?, htmlUrl?, isActive?, replyTo?, toField?, tag?, attachmentUrl?.',
  parameters: {
    type: 'object',
    properties: {
      templateName: { type: 'string', description: 'Name of the template (required).' },
      subject: { type: 'string', description: 'Subject line of the template (required).' },
      sender: {
        type: 'object',
        description:
          'Sender — EITHER { email } (a verified sender) OR { id } (a Brevo sender id), not both. Optional name.',
        properties: {
          email: { type: 'string', description: 'Verified sender email address.' },
          id: { type: 'number', description: 'Brevo sender id (alternative to email).' },
          name: { type: 'string', description: 'Optional sender display name.' },
        },
      },
      htmlContent: {
        type: 'string',
        description: 'HTML body (at least 10 characters). Provide this or htmlUrl.',
      },
      htmlUrl: {
        type: 'string',
        description: 'Absolute http(s) URL whose content is the HTML body. Provide this or htmlContent.',
      },
      isActive: {
        type: 'boolean',
        description: 'Whether the template is active (default false — inactive).',
        default: false,
      },
      replyTo: { type: 'string', description: 'Optional Reply-To email address.' },
      toField: {
        type: 'string',
        description: 'Optional personalization of the To field (e.g. {{contact.FNAME}} {{contact.LNAME}}).',
      },
      tag: { type: 'string', description: 'Optional tag for the template.' },
      attachmentUrl: {
        type: 'string',
        description: 'Optional absolute http(s) URL of an attachment.',
      },
    },
    required: ['templateName', 'subject', 'sender'],
  },
  annotations: {
    readOnlyHint: false,
    version: '1.0.0',
    stability: 'stable',
    openWorldHint: true,
    idempotentHint: false,
  },
  handler: async (args, context) => {
    validateCreateTemplateArgs(args);
    const body = buildCreateTemplateBody(args as Record<string, unknown>);

    const res = await brevoRequest<CreateTemplateResponse>(context, '/smtp/templates', {
      method: 'POST',
      body,
    });

    return {
      id: typeof res?.id === 'number' ? res.id : null,
      templateName: body.templateName,
      subject: body.subject,
      isActive: body.isActive ?? false,
    };
  },
};
