/**
 * -health-check — private tool (the '-' prefix keeps it out of the
 * permission map, always allowed). Verifies configuration without leaking
 * secret values: transport mode resolved, which secrets are present, and —
 * when a mailbox is configured — a live session() check.
 */
import type { ToolConfig } from '@teros/mca-sdk';
import { resolveMailbox, resolveTransport } from '../lib/config.js';
import { pick } from '../lib/config.js';
import { withSystemSecrets } from './helpers.js';

export const healthCheck: ToolConfig = {
  description:
    'Internal health check. Verifies transport configuration (mode, which secrets are present — never their values) and, when MAIL_ACCOUNT is configured, a live JMAP session with the derived or explicit password.',
  parameters: {
    type: 'object',
    properties: {},
  },
  annotations: { version: '1.0.0', stability: 'stable', readOnlyHint: true },
  handler: async (_args, context) => {
    const system = await withSystemSecrets(context);
    let user: Record<string, string> = {};
    try {
      user = (await context.getUserSecrets()) ?? {};
    } catch {
      user = {};
    }

    const present = (v: string | undefined): boolean => Boolean(v && String(v).trim());
    const directConfigured = present(pick(system, 'STALWART_BASE_URL', 'SECRET_MCA')) && present(pick(system, 'STALWART_ADMIN_TOKEN', 'SECRET_MCA'));
    const masterConfigured = present(pick(system, 'STALWART_MASTER_SECRET', 'SECRET_MCA'));

    const result: Record<string, unknown> = {
      transport: directConfigured ? 'direct' : 'unconfigured',
      directConfigured,
      masterConfigured,
      mailbox: null,
      mailboxOk: false,
    };

    const account = user.MAIL_ACCOUNT ?? process.env.SECRET_USER_MAIL_ACCOUNT;
    if (present(account)) {
      result.mailbox = account;
      try {
        const rt = resolveTransport(system);
        const mailbox = resolveMailbox(user, system);
        await rt.client.session(mailbox.account, mailbox.password);
        result.mailboxOk = true;
      } catch (err) {
        result.mailboxError = err instanceof Error ? err.message : String(err);
      }
    }
    return result;
  },
};
