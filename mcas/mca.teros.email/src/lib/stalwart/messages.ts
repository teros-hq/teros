/**
 * Message operations (list / read / markRead / destroy) over standard JMAP.
 *
 * KNOWN STALWART BUG #1 (spec §8): `Email/query` with a filter FAILS in this
 * server version. `listMessages` therefore fetches with `Email/get ids:null`
 * (minimal properties) and filters/sorts/paginates client-side.
 *
 * @todo nira - 2026-11-01: re-test Email/query with a filter after every
 * Stalwart upgrade — if it works, replace the fetch-all of Email/get ids:null
 * with a server-side query + pagination.
 */
import { toolError } from '../errors.js';
import { byTag } from './client.js';
import type { AuthMode } from './transport.js';
import { USING_MAIL, type EmailSummary, type JmapResult } from './types.js';
import type { Transport } from './transport.js';

/** Minimal summary properties — keeps the fetch-all cheap server-side. */
const SUMMARY_PROPERTIES = ['id', 'mailboxIds', 'from', 'to', 'subject', 'receivedAt', 'keywords', 'size'];

interface EmailAddressShape {
  email?: string;
  name?: string;
}

function fmtAddress(a: EmailAddressShape | undefined): string | null {
  if (!a?.email) return null;
  return a.name ? `${a.name} <${a.email}>` : a.email;
}

export function toSummary(raw: Record<string, unknown>): EmailSummary {
  const fromList = (raw.from as EmailAddressShape[] | undefined) ?? [];
  const toList = (raw.to as EmailAddressShape[] | undefined) ?? [];
  const keywords = (raw.keywords as Record<string, boolean> | undefined) ?? {};
  return {
    id: String(raw.id ?? ''),
    from: fmtAddress(fromList[0]),
    fromName: fromList[0]?.name ?? null,
    to: toList.map((a) => a.email).filter((e): e is string => Boolean(e)),
    subject: (raw.subject as string | undefined) ?? null,
    receivedAt: (raw.receivedAt as string | undefined) ?? null,
    seen: keywords.$seen === true,
    flagged: keywords.$flagged === true,
    draft: keywords.$draft === true,
    size: typeof raw.size === 'number' ? raw.size : null,
  };
}

export class MessageOps {
  constructor(
    private readonly transport: Transport,
    private readonly auth: () => AuthMode,
  ) {}

  /**
   * List messages of one mailbox, newest first. Bug #1 workaround: fetch-all
   * via Email/get ids:null + client-side filter/sort/paginate.
   */
  async listMessages(
    accountId: string,
    mailboxId: string,
    opts: { limit: number; offset: number; unreadOnly: boolean },
  ): Promise<{ total: number; offset: number; messages: EmailSummary[] }> {
    const res = await this.transport.jmap(USING_MAIL, [
      ['Email/get', {
        accountId,
        ids: null,
        properties: SUMMARY_PROPERTIES,
      }, 'c0'],
    ], this.auth());
    const list = (byTag(res, 'c0')?.list as Array<Record<string, unknown>>) ?? [];
    const inMailbox = list.filter((raw) => {
      const mbs = (raw.mailboxIds as Record<string, boolean> | undefined) ?? {};
      return mbs[mailboxId] === true;
    });
    const filtered = opts.unreadOnly ? inMailbox.filter((raw) => toSummary(raw).seen === false) : inMailbox;
    filtered.sort((a, b) => String(b.receivedAt ?? '').localeCompare(String(a.receivedAt ?? '')));
    const page = filtered.slice(opts.offset, opts.offset + opts.limit);
    return { total: filtered.length, offset: opts.offset, messages: page.map(toSummary) };
  }

  /** Read one message in full: headers + text and HTML bodies when present. */
  async readMessage(accountId: string, messageId: string): Promise<Record<string, unknown>> {
    const res = await this.transport.jmap(USING_MAIL, [
      ['Email/get', {
        accountId,
        ids: [messageId],
        properties: [
          'id', 'blobId', 'threadId', 'mailboxIds', 'keywords', 'from', 'to', 'cc', 'replyTo',
          'subject', 'receivedAt', 'size', 'textBody', 'htmlBody', 'bodyValues',
        ],
        fetchTextBodyValues: true,
        fetchHTMLBodyValues: true,
      }, 'c0'],
    ], this.auth());
    const list = (byTag(res, 'c0')?.list as Array<Record<string, unknown>>) ?? [];
    const raw = list[0];
    if (!raw) {
      throw toolError('NOT_FOUND', `Message ${messageId} not found`, 'ids come from list-messages; the message may have been destroyed or moved');
    }
    const textParts = (raw.textBody as Array<{ partId?: string; type?: string }> | undefined) ?? [];
    const htmlParts = (raw.htmlBody as Array<{ partId?: string; type?: string }> | undefined) ?? [];
    const bodyValues = (raw.bodyValues as Record<string, { value?: string; isEncodingProblem?: boolean }> | undefined) ?? {};
    const text = textParts.map((p) => bodyValues[p.partId ?? '']?.value ?? '').join('\n\n').trim();
    const html = htmlParts.map((p) => bodyValues[p.partId ?? '']?.value ?? '').join('\n').trim();
    return {
      ...toSummary(raw),
      cc: ((raw.cc as EmailAddressShape[] | undefined) ?? []).map((a) => a.email).filter(Boolean),
      replyTo: fmtAddress(((raw.replyTo as EmailAddressShape[] | undefined) ?? [])[0]),
      blobId: raw.blobId ?? null,
      threadId: raw.threadId ?? null,
      text: text || null,
      html: html || null,
    };
  }

  /** Mark messages seen/unseen. Returns the per-id outcome. */
  async markRead(
    accountId: string,
    messageIds: string[],
    seen: boolean,
  ): Promise<{ updated: string[]; notUpdated: Record<string, unknown> }> {
    const update: Record<string, unknown> = {};
    for (const id of messageIds) {
      update[id] = { keywords: { $seen: seen } };
    }
    const res = await this.transport.jmap(USING_MAIL, [
      ['Email/set', { accountId, update }, 'c0'],
    ], this.auth());
    const updated = Object.keys((byTag(res, 'c0')?.updated as Record<string, unknown> | undefined) ?? {});
    const notUpdated = (byTag(res, 'c0')?.notUpdated as Record<string, unknown> | undefined) ?? {};
    return { updated, notUpdated };
  }

  /** Destroy messages permanently (irreversible — does NOT go through Trash). */
  async destroy(
    accountId: string,
    messageIds: string[],
  ): Promise<{ destroyed: string[]; notDestroyed: Record<string, unknown> }> {
    const res = await this.transport.jmap(USING_MAIL, [
      ['Email/set', { accountId, destroy: messageIds }, 'c0'],
    ], this.auth());
    const destroyed = (byTag(res, 'c0')?.destroyed as string[] | undefined) ?? [];
    const notDestroyed = (byTag(res, 'c0')?.notDestroyed as Record<string, unknown> | undefined) ?? {};
    return { destroyed, notDestroyed };
  }
}

/** Type re-export for callers that want the raw result shape. */
export type { JmapResult };
