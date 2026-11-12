/**
 * Agent Mailbox Service — auto-provisioning of agent mailboxes on Stalwart
 * (mca.teros.email lifecycle, tn_PcquTN30AawbK8uE).
 *
 * Responsibilities:
 * - Clean-first naming (Pablo, 1-nov): '{agente}@agents.teros.ai' if free,
 *   else '{agente}-{owner}@agents.teros.ai', else '{agente}{N}-{owner}@'.
 *   Parts normalized to [a-z0-9] (accents/spaces stripped), hyphen ONLY as
 *   separator between agent and owner.
 * - ONE mailbox per agent (unique index agentId) — upsert is idempotent.
 * - No-recycling: burned addresses are never reassigned.
 * - Provisioning NEVER fails the grant: on Stalwart errors the mailbox doc
 *   is written with status='pending' and the lazy safety-net retries later.
 *
 * The MCA process itself has no create-mailbox tool — creation lives here,
 * in the backend ("crear buzón FUERA del alcance de tools", AC 2).
 */
import { createHmac } from 'node:crypto';
import type { Collection, Db } from 'mongodb';
import { COLLECTIONS } from '../db';
import { createLogger } from '../lib/logger';
import { secrets } from '../secrets/secrets-manager';
import type { AgentInstance, AgentMailbox, BurnedAddress } from '../types/database';

const log = createLogger('AgentMailbox');

/** Default domain for agent mailboxes (agents.teros.ai — domainId 'c' on the Stalwart server). */
const AGENT_DOMAIN = 'agents.teros.ai';

/** Normalize a display name to a [a-z0-9] slug: accents → ASCII, spaces/punctuation dropped. */
export function slugify(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Local part must be [a-z0-9] only (hyphen allowed solely as the agent-owner separator). */
const LOCAL_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Deterministic mailbox password derivation (same scheme as mca.teros.email's
 * derivePassword — HMAC-SHA256 of 'v1:<address>' over the master secret).
 * Exported for the connection manager, which serves it to the MCA without
 * ever storing it.
 */
export function deriveMailboxPassword(email: string, masterSecret: string): string {
  const digest = createHmac('sha256', masterSecret).update('v1:' + email.trim().toLowerCase()).digest('hex');
  let n = BigInt('0x' + digest);
  const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  while (out.length < 32) {
    out += CHARSET[Number(n % 62n)];
    n /= 62n;
  }
  return out.slice(0, 32);
}

export interface ProvisionOptions {
  /** Human-chosen local part (validated + uniqueness-checked; 409-style failure when taken). */
  preferredName?: string;
  /** Domain for the mailbox (default agents.teros.ai). */
  domain?: string;
}

export interface ProvisionResult {
  created: boolean;
  address: string;
  status: 'active' | 'pending' | 'renamed';
  reason?: string;
}

/** One JMAP method call: [methodName, args, callId]. */
type JmapCall = [string, Record<string, unknown>, string];
/** One JMAP method response: [methodName, args, callId]. */
type JmapResponse = [string, Record<string, unknown>, string];

/** A Stalwart account as returned by x:Account/get. */
interface StalwartAccount {
  id: string;
  name?: string;
  emailAddress?: string;
  aliases?: Array<{ name?: string; domainId?: string }> | null;
}

/** Minimal Stalwart admin-plane client (direct transport, JMAP x:* methods). */
class StalwartAdminClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async jmap(methodCalls: JmapCall[]): Promise<JmapResponse[]> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/jmap/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'],
        methodCalls,
      }),
    });
    if (!res.ok) {
      throw new Error(`Stalwart HTTP ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { methodResponses?: JmapResponse[] };
    const responses = body.methodResponses ?? [];
    const firstError = responses.find((r) => r?.[0] === 'error');
    if (firstError) {
      const args = (firstError[1] ?? {}) as { type?: string; description?: string };
      throw new Error(`JMAP ${args.type ?? 'error'}${args.description ? `: ${args.description}` : ''}`);
    }
    return responses;
  }

  /** All accounts (id, name, emailAddress, aliases). */
  async listAccounts(): Promise<StalwartAccount[]> {
    const responses = await this.jmap([
      ['x:Account/query', { filter: {} }, 'q'],
      ['x:Account/get', { '#ids': { resultOf: 'q', name: 'x:Account/query', path: '/ids' }, properties: ['name', 'emailAddress', 'aliases'] }, 'g'],
    ]);
    const get = (responses.find((r) => r[2] === 'g')?.[1] ?? {}) as { list?: StalwartAccount[] };
    return get.list ?? [];
  }

  /** Find the domainId of a domain by exact name. */
  async findDomainId(domain: string): Promise<string | undefined> {
    const responses = await this.jmap([
      ['x:Domain/query', { filter: { name: domain } }, 'q'],
      ['x:Domain/get', { '#ids': { resultOf: 'q', name: 'x:Domain/query', path: '/ids' }, properties: ['name'] }, 'g'],
    ]);
    const get = (responses.find((r) => r[2] === 'g')?.[1] ?? {}) as { list?: Array<{ id: string; name?: string }> };
    return (get.list ?? []).find((d) => d.name === domain)?.id;
  }

  /** Create a mailbox account with a derived password. */
  async createAccount(localPart: string, domainId: string, password: string, description: string): Promise<string> {
    const responses = await this.jmap([
      ['x:Account/set', {
        create: {
          new1: {
            '@type': 'User',
            name: localPart,
            domainId,
            description,
            credentials: { 0: { '@type': 'Password', secret: password } },
            roles: { '@type': 'User' },
            permissions: { '@type': 'Inherit' },
            encryptionAtRest: { '@type': 'Disabled' },
          },
        },
      }, 'c0'],
    ]);
    const created = responses.find((r) => r[2] === 'c0')?.[1] ?? {};
    const id = (created as { created?: Record<string, { id?: string }> }).created?.new1?.id;
    if (!id) {
      throw new Error(`Account not created: ${JSON.stringify((created as { notCreated?: unknown }).notCreated)}`);
    }
    return id;
  }
}

export class AgentMailboxService {
  /** Optional AuthManager — needed only for legacy-mailbox adoption (migration). */
  private authManager?: { get: (userId: string, appId: string) => Promise<Record<string, unknown> | null> };

  constructor(private db: Db, authManager?: { get: (userId: string, appId: string) => Promise<Record<string, unknown> | null> }) {
    this.authManager = authManager;
  }

  private get mailboxes(): Collection<AgentMailbox> {
    return this.db.collection<AgentMailbox>(COLLECTIONS.agentMailboxes);
  }

  private get burned(): Collection<BurnedAddress> {
    return this.db.collection<BurnedAddress>(COLLECTIONS.burnedAddresses);
  }

  /**
   * Provision (or return) the mailbox of an agent. Idempotent: if the agent
   * already has one, it is returned as-is (created:false). NEVER throws for
   * Stalwart failures — the doc is stored as pending and retried lazily.
   */
  async ensureMailbox(agent: AgentInstance, opts: ProvisionOptions = {}): Promise<ProvisionResult> {
    const existing = await this.mailboxes.findOne({ agentId: agent.agentId });
    if (existing) {
      if (existing.status === 'pending') {
        // Retry a pending provisioning (safety-net path or re-grant).
        return this.provision(agent, existing.address, existing.domainId, opts);
      }
      return { created: false, address: existing.address, status: existing.status };
    }

    const domain = opts.domain ?? AGENT_DOMAIN;
    const preferred = opts.preferredName?.trim().toLowerCase();

    // Clean-first name generation (spec §3.4).
    const candidates = this.generateCandidates(agent, preferred);
    const taken = await this.takenAddresses();

    let chosen: string | undefined;
    for (const local of candidates) {
      if (!taken.has(`${local}@${domain}`)) {
        chosen = local;
        break;
      }
    }
    if (!chosen) {
      // All candidates taken — numeric suffix loop (bounded).
      const base = slugify(agent.name ?? agent.agentId);
      const ownerSlug = slugify(agent.ownerId ?? '');
      for (let n = 2; n < 100; n++) {
        const local = `${base}${n}-${ownerSlug}`;
        if (!taken.has(`${local}@${domain}`)) {
          chosen = local;
          break;
        }
      }
    }
    if (!chosen) {
      throw new Error(`No free mailbox name for agent ${agent.agentId} (all candidates exhausted)`);
    }

    return this.provision(agent, `${chosen}@${domain}`, domain, opts);
  }

  /**
   * Clean-first candidate list: preferred (if given) → {agente} →
   * {agente}-{owner} → {agente}2-{owner} … (spec §3.4).
   */
  private generateCandidates(agent: AgentInstance, preferred?: string): string[] {
    const base = slugify(agent.name ?? agent.agentId);
    const ownerSlug = slugify(agent.ownerId ?? '');
    const candidates: string[] = [];
    if (preferred && LOCAL_RE.test(preferred)) {
      candidates.push(preferred);
    }
    candidates.push(base);
    if (ownerSlug) {
      candidates.push(`${base}-${ownerSlug}`);
    }
    return candidates;
  }

  /** All addresses known to be taken: Stalwart primaries + aliases + local registry + burned. */
  private async takenAddresses(): Promise<Set<string>> {
    const taken = new Set<string>();
    try {
      const client = await this.stalwartClient();
      const accounts = await client.listAccounts();
      for (const acc of accounts) {
        if (acc.emailAddress) taken.add(acc.emailAddress.toLowerCase());
        for (const alias of acc.aliases ?? []) {
          // Aliases carry name+domainId — we approximate with any domain we know is taken
          if (alias.name) taken.add(alias.name);
        }
      }
    } catch (err) {
      log.warn({ err }, 'Failed to list Stalwart accounts — proceeding with local registry only');
    }
    const local = await this.mailboxes.find({}, { projection: { _id: 0, address: 1 } }).toArray();
    for (const m of local) taken.add(m.address.toLowerCase());
    const burned = await this.burned.find({}, { projection: { _id: 0, address: 1 } }).toArray();
    for (const b of burned) taken.add(b.address.toLowerCase());
    return taken;
  }

  /** Create the Stalwart account and persist the mailbox doc (never throws up). */
  private async provision(agent: AgentInstance, address: string, domainId: string, _opts: ProvisionOptions): Promise<ProvisionResult> {
    const now = new Date().toISOString();
    const doc = {
      agentId: agent.agentId,
      address,
      domainId,
      fromName: agent.fullName ?? agent.name,
      status: 'pending' as const,
      createdAt: now,
      updatedAt: now,
      attempts: 1,
    };
    // Reserve the address locally BEFORE calling Stalwart (unique index on
    // address makes the reservation race-safe across concurrent grants).
    try {
      await this.mailboxes.insertOne(doc);
    } catch (err: unknown) {
      const code = (err as { code?: string | number }).code;
      if (code === 11000 /* E11000 duplicate */ || code === '11000') {
        // Another grant won the race (or a rename claimed it) — return the winner.
        const winner = await this.mailboxes.findOne({ agentId: agent.agentId });
        if (winner) {
          return { created: false, address: winner.address, status: winner.status };
        }
        const byAddress = await this.mailboxes.findOne({ address });
        if (byAddress) {
          throw new Error(`Address ${address} already assigned to another agent (${byAddress.agentId})`);
        }
        throw err;
      }
      throw err;
    }

    try {
      const { STALWART_BASE_URL, STALWART_ADMIN_TOKEN, STALWART_MASTER_SECRET } = this.secrets();
      if (!STALWART_BASE_URL || !STALWART_ADMIN_TOKEN || !STALWART_MASTER_SECRET) {
        throw new Error('Stalwart system secrets not configured (BASE_URL/ADMIN_TOKEN/MASTER_SECRET)');
      }
      const client = new StalwartAdminClient(STALWART_BASE_URL, STALWART_ADMIN_TOKEN);
      const resolvedDomainId = await client.findDomainId(domainId === AGENT_DOMAIN ? AGENT_DOMAIN : domainId);
      if (!resolvedDomainId) {
        throw new Error(`Domain ${domainId} not found on the Stalwart server`);
      }
      const localPart = address.split('@')[0];
      const password = deriveMailboxPassword(address, STALWART_MASTER_SECRET);
      const stalwartAccountId = await client.createAccount(localPart, resolvedDomainId, password, `${agent.fullName ?? agent.name} — Teros agent`);
      await this.mailboxes.updateOne(
        { agentId: agent.agentId },
        { $set: { stalwartAccountId, domainId: resolvedDomainId, status: 'active' as const, updatedAt: new Date().toISOString() } },
      );
      log.info({ agentId: agent.agentId, address }, 'Agent mailbox provisioned');
      return { created: true, address, status: 'active' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err, agentId: agent.agentId, address }, 'Mailbox provisioning deferred (pending) — grant NOT failed');
      await this.mailboxes.updateOne(
        { agentId: agent.agentId },
        { $set: { status: 'pending' as const, lastError: message, updatedAt: new Date().toISOString() }, $inc: { attempts: 1 } },
      );
      return { created: false, address, status: 'pending', reason: message };
    }
  }

  /**
   * Record a rename: update the address, keep the old one in renamedFrom.
   * The Stalwart-side rename (name update + alias) is done by the admin MCA
   * tool; this method only syncs the local registry afterwards.
   */
  async recordRename(agentId: string, oldAddress: string, newAddress: string): Promise<void> {
    const now = new Date().toISOString();
    await this.mailboxes.updateOne(
      { agentId },
      {
        $set: { address: newAddress, status: 'renamed' as const, updatedAt: now },
        $push: { renamedFrom: oldAddress },
      },
    );
  }

  /** Burn an address forever (no-recycling). */
  async burn(agentId: string, ownerId: string | undefined, address: string): Promise<void> {
    await this.burned.updateOne(
      { address },
      { $set: { address, agentId, ownerId, burnedAt: new Date().toISOString() } },
      { upsert: true },
    );
  }

  /** Resolve the mailbox of an agent (null when none). */
  async getMailbox(agentId: string) {
    return this.db.collection(COLLECTIONS.agentMailboxes).findOne({ agentId });
  }

  /**
   * ADOPT (migration, spec §3.8): register a mailbox the agent already uses
   * (legacy MAIL_ACCOUNT user secret) in agent_mailboxes instead of creating
   * a new one. Resolves the Stalwart account id via x:Account when possible;
   * never throws for Stalwart failures (status stays pending → lazy retry).
   */
  async adoptMailbox(agent: AgentInstance, address: string): Promise<ProvisionResult> {
    const domain = address.split('@')[1] ?? AGENT_DOMAIN;
    const now = new Date().toISOString();

    // Reserve first (race-safe via unique indexes), same as provision().
    try {
      await this.mailboxes.insertOne({
        agentId: agent.agentId,
        address,
        domainId: domain,
        fromName: agent.fullName ?? agent.name,
        status: 'pending' as const,
        createdAt: now,
        updatedAt: now,
        attempts: 1,
      });
    } catch (err: unknown) {
      const code = (err as { code?: string | number }).code;
      if (code === 11000 || code === '11000') {
        const winner = await this.mailboxes.findOne({ agentId: agent.agentId });
        if (winner) {
          return { created: false, address: winner.address, status: winner.status };
        }
        throw new Error(`Address ${address} already registered to another agent`);
      }
      throw err;
    }

    // Best-effort: resolve the Stalwart account id for admin operations.
    try {
      const client = await this.stalwartClientOrThrow();
      const accounts = await client.listAccounts();
      const match = accounts.find(
        (acc) => acc.emailAddress?.toLowerCase() === address.toLowerCase(),
      );
      await this.mailboxes.updateOne(
        { agentId: agent.agentId },
        {
          $set: {
            stalwartAccountId: match?.id,
            status: 'active' as const,
            updatedAt: new Date().toISOString(),
          },
        },
      );
      return { created: true, address, status: 'active' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ err, agentId: agent.agentId, address }, 'Mailbox adoption deferred (pending)');
      await this.mailboxes.updateOne(
        { agentId: agent.agentId },
        { $set: { status: 'pending' as const, lastError: message, updatedAt: new Date().toISOString() } },
      );
      return { created: true, address, status: 'pending', reason: message };
    }
  }

  /**
   * Legacy mailbox detection (migration): the address the agent's owner
   * already uses for the email app, from user credentials (user_credentials
   * — same resolution the runtime uses). Null when none.
   */
  async findLegacyMailboxAddress(agent: AgentInstance, appId: string): Promise<string | undefined> {
    if (!agent.ownerId) return undefined;
    try {
      const credentials = await this.authManager?.get(agent.ownerId, appId);
      const account = credentials?.MAIL_ACCOUNT;
      return typeof account === 'string' && account.includes('@') ? account : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The Stalwart admin secrets, read from the same filesystem store the
   * MCA manager uses (.secrets/mcas/mca.teros.email/credentials.json).
   */
  private secrets(): { STALWART_BASE_URL?: string; STALWART_ADMIN_TOKEN?: string; STALWART_MASTER_SECRET?: string } {
    const all = (secrets.mca('mca.teros.email') ?? {}) as Record<string, string>;
    return {
      STALWART_BASE_URL: all.STALWART_BASE_URL,
      STALWART_ADMIN_TOKEN: all.STALWART_ADMIN_TOKEN,
      STALWART_MASTER_SECRET: all.STALWART_MASTER_SECRET,
    };
  }

  private stalwartClient(): Promise<StalwartAdminClient> {
    const { STALWART_BASE_URL, STALWART_ADMIN_TOKEN } = this.secrets();
    if (!STALWART_BASE_URL || !STALWART_ADMIN_TOKEN) {
      return Promise.reject(new Error('Stalwart system secrets not configured'));
    }
    return Promise.resolve(new StalwartAdminClient(STALWART_BASE_URL, STALWART_ADMIN_TOKEN));
  }

  /** Stalwart client that THROWS on missing secrets (used by adoptMailbox's pending path). */
  private async stalwartClientOrThrow(): Promise<StalwartAdminClient> {
    const { STALWART_BASE_URL, STALWART_ADMIN_TOKEN } = this.secrets();
    if (!STALWART_BASE_URL || !STALWART_ADMIN_TOKEN) {
      throw new Error('Stalwart system secrets not configured (BASE_URL/ADMIN_TOKEN)');
    }
    return new StalwartAdminClient(STALWART_BASE_URL, STALWART_ADMIN_TOKEN);
  }
}
