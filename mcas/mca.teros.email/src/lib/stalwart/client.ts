/**
 * Stalwart client — admin + mail operations over JMAP.
 * Payloads mirror the ones proven against this Stalwart version by the
 * verified stalwart-tools seed.
 *
 * All methods throw on failure (ToolError with [CODE]); JMAP errors inside
 * HTTP 200 are caught by the transport's assertNoJmapErrors.
 */
import { toolError } from '../errors.js';
import { Transport, type AuthMode, type TransportConfig } from './transport.js';
import {
  USING_ADMIN,
  USING_MAIL,
  USING_SUBMIT,
  type Account,
  type Domain,
  type Identity,
  type JmapResult,
  type JmapSession,
  type Mailbox,
} from './types.js';

export interface CreateAccountOptions {
  /** Local part, e.g. 'alice' (the domain comes from domainId). */
  name: string;
  domainId: string;
  /** Display name / description. */
  description?: string;
  password: string;
}

export interface SendEmailOptions {
  to: string[];
  subject: string;
  text: string;
  /** Optional HTML body — sent as text/html alongside the plain-text alternative. */
  html?: string;
  /** Mailbox credentials — the sender IS the authenticated account. */
  user: string;
  pass: string;
  /** Display name for the From header, e.g. 'Alice from Teros.ai'. */
  fromName?: string;
}

/** Helper to pull a method response by call tag. */
export function byTag(res: JmapResult, tag: string): Record<string, unknown> | undefined {
  return res.methodResponses.find((r) => r[2] === tag)?.[1];
}

export class StalwartClient {
  readonly transport: Transport;

  constructor(cfg: TransportConfig) {
    this.transport = new Transport(cfg);
  }

  private adminAuth(): AuthMode {
    return { mode: 'token' };
  }

  private basicAuth(user: string, pass: string): AuthMode {
    return { mode: 'basic', user, pass };
  }

  // ---------------------------------------------------------------------
  // Admin — domains
  // ---------------------------------------------------------------------

  /** List all domains. */
  async listDomains(): Promise<Domain[]> {
    const res = await this.transport.jmap(USING_ADMIN, [
      ['x:Domain/query', { filter: {} }, 'q'],
      ['x:Domain/get', { '#ids': { resultOf: 'q', name: 'x:Domain/query', path: '/ids' }, properties: ['name', 'isEnabled', 'description'] }, 'g'],
    ], this.adminAuth());
    return (byTag(res, 'g')?.list as Domain[]) ?? [];
  }

  /** Find a domain by exact name. */
  async findDomain(name: string): Promise<Domain | null> {
    const res = await this.transport.jmap(USING_ADMIN, [
      ['x:Domain/query', { filter: { name } }, 'q'],
      ['x:Domain/get', { '#ids': { resultOf: 'q', name: 'x:Domain/query', path: '/ids' }, properties: ['name', 'isEnabled', 'description'] }, 'g'],
    ], this.adminAuth());
    const list = (byTag(res, 'g')?.list as Domain[]) ?? [];
    return list.find((d) => d.name === name) ?? null;
  }

  /** DNS zone file for a domain (MX, SPF, DKIM, DMARC, SRV, MTA-STS…). */
  async dnsZoneFile(domainId: string): Promise<{ name?: string; dnsZoneFile: string }> {
    const res = await this.transport.jmap(USING_ADMIN, [
      ['x:Domain/get', { ids: [domainId], properties: ['name', 'dnsZoneFile'] }, 'g'],
    ], this.adminAuth());
    const list = (byTag(res, 'g')?.list as Array<{ name?: string; dnsZoneFile?: string }>) ?? [];
    return { name: list[0]?.name, dnsZoneFile: list[0]?.dnsZoneFile ?? '' };
  }

  // ---------------------------------------------------------------------
  // Admin — accounts
  // ---------------------------------------------------------------------

  /** List all accounts. */
  async listAccounts(): Promise<Account[]> {
    const res = await this.transport.jmap(USING_ADMIN, [
      ['x:Account/query', { filter: {} }, 'q'],
      ['x:Account/get', { '#ids': { resultOf: 'q', name: 'x:Account/query', path: '/ids' } }, 'g'],
    ], this.adminAuth());
    return (byTag(res, 'g')?.list as Account[]) ?? [];
  }

  /** Create a mailbox account (user@domain). */
  async createAccount(opts: CreateAccountOptions): Promise<Account> {
    const res = await this.transport.jmap(USING_ADMIN, [
      ['x:Account/set', {
        create: {
          new1: {
            '@type': 'User',
            name: opts.name,
            domainId: opts.domainId,
            description: opts.description ?? opts.name,
            credentials: { 0: { '@type': 'Password', secret: opts.password } },
            roles: { '@type': 'User' },
            permissions: { '@type': 'Inherit' },
            encryptionAtRest: { '@type': 'Disabled' },
          },
        },
      }, 'c0'],
    ], this.adminAuth());
    const created = byTag(res, 'c0')?.created as Record<string, { id: string }> | undefined;
    const id = created?.new1?.id;
    if (!id) {
      throw toolError('JMAP_ERROR', `Account not created: ${JSON.stringify(byTag(res, 'c0')?.notCreated)}`);
    }
    return { id, name: opts.name, description: opts.description };
  }

  /** Replace an account's password (drops any app passwords it had). */
  async changePassword(accountId: string, newPassword: string): Promise<void> {
    const res = await this.transport.jmap(USING_ADMIN, [
      ['x:Account/set', {
        update: {
          [accountId]: { credentials: { 0: { '@type': 'Password', secret: newPassword } } },
        },
      }, 'c0'],
    ], this.adminAuth());
    const notUpdated = byTag(res, 'c0')?.notUpdated as Record<string, unknown> | undefined;
    if (notUpdated && notUpdated[accountId]) {
      throw toolError('JMAP_ERROR', `Password not updated: ${JSON.stringify(notUpdated[accountId])}`);
    }
  }

  // ---------------------------------------------------------------------
  // Mail (per-mailbox basic auth)
  // ---------------------------------------------------------------------

  /** Fetch the JMAP session for a mailbox (capabilities, accounts, primary accountId). */
  async session(user: string, pass: string): Promise<JmapSession> {
    return (await this.transport.get('/.well-known/jmap', this.basicAuth(user, pass))) as JmapSession;
  }

  /** Resolve the primary mail accountId for a mailbox. */
  async primaryAccountId(user: string, pass: string): Promise<string> {
    const s = await this.session(user, pass);
    const id = s.primaryAccounts?.['urn:ietf:params:jmap:mail'];
    if (!id) {
      throw toolError('AUTH_INVALID', `No primary mail account in JMAP session for ${user}`);
    }
    return id;
  }

  /** List mailboxes (folders) of the authenticated account, sorted by sortOrder. */
  async listMailboxes(user: string, pass: string, accountId: string): Promise<Mailbox[]> {
    const res = await this.transport.jmap(USING_MAIL, [
      ['Mailbox/get', {
        accountId,
        ids: null,
        properties: ['name', 'role', 'parentId', 'totalEmails', 'unreadEmails', 'sortOrder'],
      }, 'c0'],
    ], this.basicAuth(user, pass));
    const list = (byTag(res, 'c0')?.list as Mailbox[]) ?? [];
    return list.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  }

  /** Resolve identity + drafts/sent mailboxes for sending. */
  async prepareSend(user: string, pass: string, accountId: string): Promise<{ identityId: string; email: string; draftsId: string; sentId: string }> {
    const res = await this.transport.jmap(USING_SUBMIT, [
      ['Identity/get', { accountId, ids: null }, 'ident'],
      ['Mailbox/query', { accountId, filter: { role: 'drafts' } }, 'drafts'],
      ['Mailbox/query', { accountId, filter: { role: 'sent' } }, 'sent'],
    ], this.basicAuth(user, pass));
    const ident = (byTag(res, 'ident')?.list as Identity[]) ?? [];
    const drafts = (byTag(res, 'drafts')?.ids as string[]) ?? [];
    const sent = (byTag(res, 'sent')?.ids as string[]) ?? [];
    if (!ident[0] || !drafts[0] || !sent[0]) {
      throw toolError(
        'JMAP_ERROR',
        `prepareSend incomplete: identity=${ident[0]?.id ?? 'none'} drafts=${drafts[0] ?? 'none'} sent=${sent[0] ?? 'none'}`,
        'the mailbox needs Drafts and Sent folders with roles and at least one identity',
      );
    }
    return { identityId: ident[0].id, email: ident[0].email ?? '', draftsId: drafts[0], sentId: sent[0] };
  }

  /** Send an email as a mailbox (basic auth = the sender). Plain text + optional HTML part. */
  async sendEmail(opts: SendEmailOptions): Promise<{ emailId: string; submissionId: string }> {
    const accountId = await this.primaryAccountId(opts.user, opts.pass);
    const prep = await this.prepareSend(opts.user, opts.pass, accountId);
    const res = await this.transport.jmap(USING_SUBMIT, [
      ['Email/set', {
        accountId,
        create: {
          draft: {
            mailboxIds: { [prep.draftsId]: true },
            keywords: { $draft: true, $seen: true },
            from: [{ email: opts.user, ...(opts.fromName ? { name: opts.fromName } : {}) }],
            to: opts.to.map((email) => ({ email })),
            subject: opts.subject,
            textBody: [{ partId: 'text', type: 'text/plain' }],
            ...(opts.html ? { htmlBody: [{ partId: 'html', type: 'text/html' }] } : {}),
            bodyValues: {
              text: { value: opts.text },
              ...(opts.html ? { html: { value: opts.html } } : {}),
            },
          },
        },
      }, 'c0'],
      ['EmailSubmission/set', {
        accountId,
        create: { sub: { emailId: '#draft', identityId: prep.identityId } },
        onSuccessUpdateEmail: {
          '#sub': {
            [`mailboxIds/${prep.draftsId}`]: null,
            [`mailboxIds/${prep.sentId}`]: true,
            'keywords/$draft': null,
          },
        },
      }, 'c1'],
    ], this.basicAuth(opts.user, opts.pass));
    const created = byTag(res, 'c0')?.created as Record<string, { id: string }> | undefined;
    const subCreated = byTag(res, 'c1')?.created as Record<string, { id: string }> | undefined;
    const emailId = created?.draft?.id;
    const submissionId = subCreated?.sub?.id;
    if (!emailId || !submissionId) {
      throw toolError('JMAP_ERROR', `Send failed: ${JSON.stringify(res.methodResponses).slice(0, 400)}`);
    }
    return { emailId, submissionId };
  }
}
