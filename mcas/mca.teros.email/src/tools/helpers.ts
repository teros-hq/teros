/**
 * Shared tool helpers — secret resolution and folder resolution.
 */
import type { ToolContext } from '@teros/mca-sdk';
import { mailContext } from '../lib/config.js';
import type { MailboxIdentity, ResolvedTransport } from '../lib/config.js';
import { toolError } from '../lib/errors.js';
import { byTag } from '../lib/stalwart/client.js';
import { USING_MAIL } from '../lib/stalwart/types.js';
import type { JmapSession, Mailbox } from '../lib/stalwart/types.js';

export interface MailCtx {
  rt: ResolvedTransport;
  mailbox: MailboxIdentity;
  accountId: string;
  session: JmapSession;
}

/**
 * Lazy safety-net (spec §3.7-C, tn_PcquTN30AawbK8uE): when no mailbox is
 * resolvable for this call (pre-deploy grant or a provisioning that failed
 * against Stalwart), ask the backend to provision/retry it ONCE, then
 * re-fetch the secrets and continue. Never loops: one attempt per tool call.
 */
async function provisionMailboxSafely(context: ToolContext): Promise<void> {
  const agentId = context.execution.agentId;
  const backend = context.backend as
    | { provisionMailbox?: (agentId: string) => Promise<unknown> }
    | undefined;
  if (!agentId || typeof backend?.provisionMailbox !== 'function') return;
  try {
    await backend.provisionMailbox(agentId);
  } catch {
    // Safety-net is best-effort — the original AUTH_REQUIRED error surfaces.
  }
}

/** System + user secrets (env-injected values are picked up inside config). */
export async function withMailContext(context: ToolContext): Promise<MailCtx> {
  const [system, user] = await Promise.all([
    context.getSystemSecrets().catch((): Record<string, string> => ({})),
    context.getUserSecrets().catch((): Record<string, string> => ({})),
  ]);
  if (!user.MAIL_ACCOUNT && !process.env.SECRET_USER_MAIL_ACCOUNT) {
    // No mailbox for this agent — try the lazy safety-net once, then retry.
    await provisionMailboxSafely(context);
    const retry = await context.getUserSecrets().catch((): Record<string, string> => ({}));
    Object.assign(user, retry);
  }
  return mailContext(system ?? {}, user ?? {});
}

export async function withSystemSecrets(context: ToolContext): Promise<Record<string, string>> {
  return context.getSystemSecrets().catch((): Record<string, string> => ({}));
}

/** Folder names accepted as roles by list-messages. */
const ROLES = new Set(['inbox', 'sent', 'drafts', 'trash', 'junk', 'archive', 'all']);

/**
 * Resolve the `folder` argument to a Mailbox: a role (inbox, sent…), an
 * exact folder name (case-insensitive), or a mailbox id.
 */
export async function resolveFolderId(
  rt: ResolvedTransport,
  mailbox: MailboxIdentity,
  accountId: string,
  folder: string,
): Promise<Mailbox> {
  const value = folder.trim();
  if (!value) {
    throw toolError('INVALID_REQUEST', 'folder must be a role (inbox, sent…), an exact folder name or a mailbox id');
  }
  const lower = value.toLowerCase();
  const mailboxes = await rt.client.listMailboxes(mailbox.account, mailbox.password, accountId);

  const byId = mailboxes.find((m) => m.id === value);
  if (byId) return byId;

  if (ROLES.has(lower)) {
    const res = await rt.client.transport.jmap(
      USING_MAIL,
      [['Mailbox/query', { accountId, filter: { role: lower } }, 'q']],
      { mode: 'basic', user: mailbox.account, pass: mailbox.password },
    );
    const ids = (byTag(res, 'q')?.ids as string[]) ?? [];
    if (ids[0]) {
      return mailboxes.find((m) => m.id === ids[0]) ?? { id: ids[0], name: value, role: lower };
    }
  }

  const byName = mailboxes.find((m) => (m.name ?? '').toLowerCase() === lower);
  if (byName) return byName;

  throw toolError(
    'NOT_FOUND',
    `Folder not found: ${folder}`,
    'run list-folders to see the available folders (use a role like inbox/sent or an exact name)',
  );
}
