import type { ToolConfig } from '@teros/mca-sdk';
import { brevoRequest } from '../lib/brevo-client';
import { buildSendEmailBody, validateSendEmailArgs } from './_helpers';

interface SendEmailResponse {
  messageId?: string;
  messageIds?: string[];
}

/**
 * send-transactional-email — POST /smtp/email.
 *
 * Returns DATA (ids + resolved sender/recipients), never a UI string — the
 * frontend composes the sentence. The sender email MUST be a verified
 * sender/domain in the Brevo account (otherwise Brevo returns 400/403).
 */
export const sendTransactionalEmail: ToolConfig = {
  description:
    'Send a transactional email via Brevo (POST /smtp/email). Returns { messageId, subject, sender, recipients, recipientCount }. The sender email MUST be a verified sender or domain in the Brevo account. Provide htmlContent and/or textContent (at least one). Params: sender{email,name?}, to[{email,name?}] (≥1), subject, htmlContent?, textContent?, cc?, bcc?, replyTo{email,name?}?, params? (template variables), tags?.',
  parameters: {
    type: 'object',
    properties: {
      sender: {
        type: 'object',
        description: 'Verified sender. { email (required), name? }.',
        properties: {
          email: { type: 'string', description: 'Verified sender email address.' },
          name: { type: 'string', description: 'Optional sender display name.' },
        },
        required: ['email'],
      },
      to: {
        type: 'array',
        description: 'Recipients (≥1). Each { email (required), name? }.',
        items: {
          type: 'object',
          properties: {
            email: { type: 'string', description: 'Recipient email address.' },
            name: { type: 'string', description: 'Optional recipient name.' },
          },
          required: ['email'],
        },
      },
      subject: { type: 'string', description: 'Email subject line.' },
      htmlContent: {
        type: 'string',
        description: 'HTML body. At least one of htmlContent / textContent is required.',
      },
      textContent: {
        type: 'string',
        description: 'Plain-text body. At least one of htmlContent / textContent is required.',
      },
      cc: {
        type: 'array',
        description: 'Optional CC recipients. Each { email (required), name? }.',
        items: {
          type: 'object',
          properties: {
            email: { type: 'string' },
            name: { type: 'string' },
          },
          required: ['email'],
        },
      },
      bcc: {
        type: 'array',
        description: 'Optional BCC recipients. Each { email (required), name? }.',
        items: {
          type: 'object',
          properties: {
            email: { type: 'string' },
            name: { type: 'string' },
          },
          required: ['email'],
        },
      },
      replyTo: {
        type: 'object',
        description: 'Optional Reply-To. { email (required), name? }.',
        properties: {
          email: { type: 'string' },
          name: { type: 'string' },
        },
        required: ['email'],
      },
      params: {
        type: 'object',
        description: 'Optional template variables substituted in the content (e.g. { FNAME: "Ana" }).',
      },
      tags: {
        type: 'array',
        description: 'Optional tags for tracking/reporting.',
        items: { type: 'string' },
      },
    },
    required: ['sender', 'to', 'subject'],
  },
  annotations: { readOnlyHint: false,
    version: '1.0.0',
    stability: 'stable',
    // Sends mail to an arbitrary recipient — there is no undo. `destructiveHint`
    // is the MCP-standard signal; the Teros backend gate also reads
    // `irreversible: true` from tools.json (not part of the MCP annotation type,
    // so it cannot live here) to exclude this tool from grouped "Allow all".
    destructiveHint: true,
    openWorldHint: true,
    idempotentHint: false,
  },
  handler: async (args, context) => {
    validateSendEmailArgs(args);
    const body = buildSendEmailBody(args as Record<string, unknown>);

    const res = await brevoRequest<SendEmailResponse>(context, '/smtp/email', {
      method: 'POST',
      body,
    });

    return {
      messageId: res.messageId ?? res.messageIds?.[0] ?? null,
      messageIds: res.messageIds,
      subject: body.subject,
      sender: body.sender,
      recipients: body.to,
      recipientCount: body.to.length,
    };
  },
};
