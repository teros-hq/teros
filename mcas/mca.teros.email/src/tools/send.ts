/**
 * send — send an email from THIS instance's mailbox. The sender is ALWAYS
 * MAIL_ACCOUNT (identity is fixed at install time, never by tool args).
 * Draft + submit in one JMAP request; the message lands in Sent.
 *
 * The enforced signature (spec §3.6) is appended to every message — the
 * agent cannot opt out; there is no parameter for it.
 */
import type { ToolConfig } from '@teros/mca-sdk';
import { toolError } from '../lib/errors.js';
import { withMailContext } from './helpers.js';
import { applySignature, resolveAgentName } from './signature.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const send: ToolConfig = {
  description:
    "Send an email from this instance's mailbox (the sender is ALWAYS the configured MAIL_ACCOUNT — never a tool parameter). Draft + submit in one JMAP request; the message is stored in Sent. Confirm with the user before sending to external recipients.",
  parameters: {
    type: 'object',
    properties: {
      to: {
        description: 'Recipient address or list of addresses.',
        anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
      },
      subject: { type: 'string', description: 'Subject.' },
      text: { type: 'string', description: 'Plain-text body (required; the text/plain part).' },
      html: { type: 'string', description: 'Optional HTML body (alternative text/html part).' },
      fromName: {
        type: 'string',
        description: 'Display name of the sender. Default: MAIL_FROM_NAME, else the JMAP identity name.',
      },
    },
    required: ['to', 'subject', 'text'],
  },
  annotations: { version: '1.0.0', stability: 'stable', openWorldHint: true },
  handler: async (args, context) => {
    const a = args as { to?: string | string[]; subject?: string; text?: string; html?: string; fromName?: string };

    const toList = (Array.isArray(a.to) ? a.to : [a.to])
      .map((s) => String(s ?? '').trim())
      .filter(Boolean);
    if (toList.length === 0) {
      throw toolError('INVALID_REQUEST', 'to must be one address or a non-empty list of addresses');
    }
    const bad = toList.filter((x) => !EMAIL_RE.test(x));
    if (bad.length > 0) {
      throw toolError('INVALID_REQUEST', `Invalid recipient address(es): ${bad.join(', ')}`);
    }
    if (!a.subject || typeof a.subject !== 'string') {
      throw toolError('INVALID_REQUEST', 'subject is required');
    }
    if (!a.text || typeof a.text !== 'string') {
      throw toolError('INVALID_REQUEST', 'text (plain-text body) is required', 'pass html too when the user wants a formatted email');
    }

    const ctx = await withMailContext(context);
    const fromName = a.fromName?.trim() || ctx.mailbox.fromName || undefined;

    // Enforced signature (spec §3.6): always appended, agent cannot opt out.
    const agentName = await resolveAgentName(context);
    const ownerName = context.execution.userDisplayName;
    const signed = applySignature(
      { text: a.text, html: typeof a.html === 'string' && a.html.trim() ? a.html : undefined },
      agentName,
      ownerName,
    );

    const { emailId, submissionId } = await ctx.rt.client.sendEmail({
      to: toList,
      subject: a.subject,
      text: signed.text,
      html: signed.html,
      user: ctx.mailbox.account,
      pass: ctx.mailbox.password,
      fromName,
    });
    return {
      emailId,
      submissionId,
      from: ctx.mailbox.account,
      to: toList,
      subject: a.subject,
      signed: true,
    };
  },
};
