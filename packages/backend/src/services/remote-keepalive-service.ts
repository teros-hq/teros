/**
 * RemoteKeepaliveService — keep-alive + inactivity TTL for Teros Remote
 * tunnels (v1.1.0, Pablo's model 2026-10-30).
 *
 * Two jobs, one hourly tick:
 *
 *   1. KEEP-ALIVE (daily): every device whose tunnel is online gets a
 *      `keepalive` envelope at least once a day while its user is active.
 *      The daemon's own watchdog (26h without a keepalive → self-shutdown)
 *      covers a dead backend and orphaned tunnels.
 *
 *   2. TTL (72h): if the user shows no signs of life for
 *      REMOTE_INACTIVITY_TTL_MS, the backend orders a clean `stop` down the
 *      tunnel (daemon exits, supervisor stays down), releases the binding and
 *      records `stoppedAt`/`stoppedReason='ttl_inactive'` — the offline
 *      diagnosis then tells the returning user exactly what happened and what
 *      to run (`teros-remote start`).
 *
 * WHAT COUNTS AS "USER ACTIVITY" (renews the TTL) — any of:
 *   - a bound-workspace member validating a session (any authenticated
 *     request touches `user_sessions.lastActivityAt`),
 *   - a message in any channel of the bound workspaces (`channels.lastMessageAt`
 *     — agent activity counts: RAW's agents work daily even when Pablo
 *     doesn't log in, so platform daemons never expire on a quiet weekend),
 *   - a successful remote tool dispatch (the user is using Teros Remote),
 *   - the daemon (re)connecting (`upsertOnline` stamps lastUserActivityAt).
 *
 * The TTL is intentionally generous (72h, the top of Pablo's 48–72h range):
 * the goal is to reap *forgotten* connections, not to police active users.
 */

import type { Db } from 'mongodb';
import { COLLECTIONS, collection } from '../db';
import { createLogger } from '../lib/logger';
import type { RemoteDevice, RemoteDeviceRegistry } from '../models/remote-devices';
import type { RemoteDeviceBindingRegistry } from '../models/remote-device-bindings';
import { REMOTE_INACTIVITY_TTL_MS, REMOTE_KEEPALIVE_INTERVAL_MS } from '@teros/shared';
import type { RemoteDeviceGateway } from './remote-device-gateway';

const log = createLogger('RemoteKeepalive');

export interface RemoteKeepaliveOptions {
  db: Db;
  registry: RemoteDeviceRegistry;
  bindingRegistry?: RemoteDeviceBindingRegistry;
  gateway: RemoteDeviceGateway;
  /** How often the tick runs (default 1h). */
  tickIntervalMs?: number;
  /** Inactivity TTL (default 72h — REMOTE_INACTIVITY_TTL_MS). */
  ttlMs?: number;
  /** Keep-alive cadence (default 24h — REMOTE_KEEPALIVE_INTERVAL_MS). */
  keepaliveIntervalMs?: number;
  /** Clock injection for tests. */
  now?: () => Date;
}

/** Per-device activity probe result. */
export interface WorkspaceActivity {
  workspaceId: string;
  lastActivityAt: Date | null;
}

export class RemoteKeepaliveService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private closed = false;
  private readonly opts: Required<
    Omit<RemoteKeepaliveOptions, 'bindingRegistry' | 'now'>
  > &
    Pick<RemoteKeepaliveOptions, 'bindingRegistry' | 'now'>;

  constructor(options: RemoteKeepaliveOptions) {
    this.opts = {
      tickIntervalMs: 3_600_000, // hourly tick → daily keepalive, hourly TTL check
      ttlMs: REMOTE_INACTIVITY_TTL_MS,
      keepaliveIntervalMs: REMOTE_KEEPALIVE_INTERVAL_MS,
      ...options,
    };
  }

  /** Start the periodic tick. */
  start(): void {
    if (this.timer || this.closed) return;
    // First tick soon after boot so a fresh backend renews/audits immediately.
    const first = setTimeout(() => void this.tick(), 10_000);
    first.unref?.();
    this.timer = setInterval(() => void this.tick(), this.opts.tickIntervalMs);
    this.timer.unref?.();
    log.info(
      { tickIntervalMs: this.opts.tickIntervalMs, keepaliveIntervalMs: this.opts.keepaliveIntervalMs, ttlMs: this.opts.ttlMs },
      'Remote keepalive/TTL service started',
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.closed = true;
  }

  /**
   * One audit pass over every online device. Safe to call manually (tests,
   * admin). Never throws — per-device failures are logged and skipped.
   */
  async tick(): Promise<{ kept: number; stopped: number; skipped: number }> {
    if (this.running || this.closed) return { kept: 0, stopped: 0, skipped: 0 };
    this.running = true;
    const now = this.opts.now?.() ?? new Date();
    let kept = 0;
    let stopped = 0;
    let skipped = 0;
    try {
      const devices = await this.opts.registry.listOnline();
      for (const device of devices) {
        try {
          const outcome = await this.auditDevice(device, now);
          if (outcome === 'kept') kept++;
          else if (outcome === 'stopped') stopped++;
          else skipped++;
        } catch (err) {
          skipped++;
          log.warn({ err, deviceId: device.deviceId }, 'Keepalive audit failed for device');
        }
      }
      if (kept || stopped) {
        log.info({ kept, stopped, skipped, total: devices.length }, 'Keepalive/TTL tick complete');
      }
      return { kept, stopped, skipped };
    } finally {
      this.running = false;
    }
  }

  private async auditDevice(device: RemoteDevice, now: Date): Promise<'kept' | 'stopped' | 'skipped'> {
    const ttlMs = this.opts.ttlMs;

    // ---- 1. Probe user activity across every bound workspace ----
    const workspaceIds = await this.boundWorkspaceIds(device);
    const activity = await this.latestUserActivity(workspaceIds, device.ownerId, now);

    // A fresher signal than the stored one renews the device's TTL clock.
    if (activity && (!device.lastUserActivityAt || activity > device.lastUserActivityAt)) {
      await this.opts.registry.touchUserActivity(device.deviceId, activity);
      device.lastUserActivityAt = activity;
    }

    // ---- 2. TTL check: no signs of life for ttlMs → clean stop ----
    const lastActivity = device.lastUserActivityAt ?? device.lastSeenAt ?? device.createdAt;
    const idleMs = now.getTime() - lastActivity.getTime();
    if (idleMs > ttlMs) {
      const stoppedAt = now.toISOString();
      log.warn(
        {
          deviceId: device.deviceId,
          name: device.name,
          idleHours: Math.round(idleMs / 3_600_000),
          lastActivity: lastActivity.toISOString(),
        },
        'Inactivity TTL expired — stopping daemon',
      );
      // Record the stop FIRST so the diagnosis has the cause even if the wire
      // write races the socket close.
      await this.opts.registry.markStopped(device.deviceId, 'ttl_inactive');
      const sent = this.opts.gateway.sendStop(
        { deviceId: device.deviceId },
        {
          reason: 'ttl_inactive',
          stoppedAt,
          message:
            `Teros Remote stopped this daemon after ${Math.round(idleMs / 3_600_000)}h without user ` +
            `activity (TTL ${Math.round(ttlMs / 3_600_000)}h). Run \`teros-remote start\` on this ` +
            `machine when you want to reconnect.`,
        },
      );
      if (!sent) {
        // No live tunnel: the daemon is already gone; the record carries the
        // cause for the next dispatch's offline diagnosis.
        log.info({ deviceId: device.deviceId }, 'No tunnel up at TTL expiry — stop recorded, binding already released');
      }
      return 'stopped';
    }

    // ---- 3. Active user → renew with a keepalive if the last one is stale ----
    const lastKeepalive = device.lastKeepaliveAt?.getTime() ?? 0;
    if (now.getTime() - lastKeepalive >= this.opts.keepaliveIntervalMs) {
      const sent = this.opts.gateway.sendKeepalive(
        { deviceId: device.deviceId },
        {
          ttlMs,
          lastUserActivityAt: lastActivity.toISOString(),
        },
      );
      if (sent) {
        await this.opts.registry.markKeepaliveSent(device.deviceId);
        log.info(
          { deviceId: device.deviceId, name: device.name, idleHours: Math.round(idleMs / 3_600_000) },
          'Keepalive sent (tunnel renewed)',
        );
        return 'kept';
      }
      // No tunnel up right now (mid-reconnect) — nothing to renew; the daemon
      // reconnects on its own and the next tick retries.
      return 'skipped';
    }
    return 'skipped';
  }

  /**
   * Workspaces bound to this device: the primary record's workspace plus every
   * active binding (multi-workspace pairing). Falls back to the record's own
   * workspace when the bindings registry is absent.
   */
  private async boundWorkspaceIds(device: RemoteDevice): Promise<string[]> {
    const ids = new Set<string>([device.workspaceId]);
    if (this.opts.bindingRegistry) {
      try {
        const bindings = await this.opts.bindingRegistry.getActiveByDeviceId(device.deviceId);
        for (const b of bindings) ids.add(b.workspaceId);
      } catch (err) {
        log.warn({ err, deviceId: device.deviceId }, 'Binding lookup failed — falling back to primary workspace');
      }
    }
    return [...ids];
  }

  /**
   * Latest user activity across the bound workspaces. Three signals, cheapest
   * first, all index-friendly:
   *   a) `channels.lastMessageAt` in the workspace — any message (human OR
   *      agent) is life in the workspace. This is the signal that keeps
   *      platform daemons (RAW) alive on weekends: agents work daily.
   *   b) `user_sessions.lastActivityAt` for active members of the workspace —
   *      a human opened/used Teros (every authenticated request touches it).
   *   c) the device's own lastSeenAt (daemon heartbeats) — weakest signal,
   *      used only as a floor so a *never-used* paired device still expires.
   * Returns the max of a/b, or null when neither collection says anything.
   */
  async latestUserActivity(
    workspaceIds: string[],
    ownerId: string,
    now: Date,
  ): Promise<Date | null> {
    if (workspaceIds.length === 0) return null;
    const candidates: Date[] = [];

    // (a) any channel message in the bound workspaces
    try {
      const ch = collection(this.opts.db, COLLECTIONS.channels);
      const doc = await ch.findOne(
        { workspaceId: { $in: workspaceIds }, lastMessageAt: { $ne: null } },
        { projection: { lastMessageAt: 1 }, sort: { lastMessageAt: -1 } },
      );
      const at = toDate(doc?.lastMessageAt);
      if (at) candidates.push(at);
    } catch (err) {
      log.warn({ err }, 'channels.lastMessageAt probe failed');
    }

    // (b) session activity of the workspace members (humans using Teros)
    try {
      const members = collection(this.opts.db, COLLECTIONS.workspaceMembers);
      const memberDocs = (await members
        .find({ workspaceId: { $in: workspaceIds } }, { projection: { userId: 1 } })
        .limit(500)
        .toArray()) as Array<{ userId?: string }>;
      const userIds = [...new Set([...memberDocs.map((m) => m.userId ?? ''), ownerId])]
        .filter(Boolean);
      if (userIds.length > 0) {
        // session-service writes lastActivityAt on user_sessions (every
        // authenticated request) — COLLECTIONS.userSessions, NOT .sessions.
        const sessions = collection(this.opts.db, COLLECTIONS.userSessions);
        const doc = await sessions.findOne(
          { userId: { $in: userIds }, lastActivityAt: { $ne: null } },
          { projection: { lastActivityAt: 1 }, sort: { lastActivityAt: -1 } },
        );
        const at = toDate(doc?.lastActivityAt);
        if (at) candidates.push(at);
      }
    } catch (err) {
      log.warn({ err }, 'user_sessions.lastActivityAt probe failed');
    }

    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) => (a > b ? a : b));
  }
}

/** Coerce Mongo's Date | string | ISODate into a Date, or null. */
function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}
