/**
 * GitHub App — server-to-server auth for `mca.github` (and future apps).
 *
 * Teros owns ONE GitHub App registered on github.com. Users INSTALL the App
 * on their repos; identity is `Teros[bot]`. The user-facing flow is:
 *
 *   1. Frontend redirects user to `https://github.com/apps/<slug>/installations/new?state=<csrf>`.
 *   2. User selects repos and confirms; GitHub redirects to the Setup URL with
 *      `?installation_id=<n>&setup_action=install&state=<csrf>`.
 *   3. `handleInstallation()` validates state, persists `INSTALLATION_ID` in
 *      the user credentials.
 *   4. The MCA (per-app container) reads `INSTALLATION_ID` from `userSecrets`
 *      and the App's private key from `systemSecrets`. It signs a JWT and
 *      exchanges it for a 1h installation access token (cached in-memory).
 *
 * This module covers steps 3 + the webhook verification used by GitHub to
 * notify us about install/uninstall events. It does NOT generate installation
 * tokens — that lives in the MCA process (see `mcas/mca.github/src/lib/github-app-token.ts`).
 *
 * Why split? The backend is multi-tenant and never holds installation tokens
 * in memory; the MCA process is per-app per-user, isolated by container, and
 * is the right place to cache the short-lived secrets.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import type { Collection, Db } from 'mongodb';
import type { McpCatalogEntry } from '../types/database';
import type { AuthManager } from './auth-manager';
import type { McaOAuth, McaOAuthStateDocument } from './mca-oauth';

/** GitHub webhook event names we care about. */
export type GitHubWebhookEvent =
  | 'installation'
  | 'installation_repositories'
  | 'ping';

/** Subset of the `installation` payload we use. */
interface InstallationPayload {
  action:
    | 'created'
    | 'deleted'
    | 'suspend'
    | 'unsuspend'
    | 'new_permissions_accepted';
  installation: {
    id: number;
    account: { login: string; id: number; type: 'User' | 'Organization' };
    repository_selection: 'selected' | 'all';
    permissions: Record<string, string>;
    suspended_at?: string | null;
  };
  repositories?: Array<{ full_name: string; private: boolean }>;
}

interface InstallationRepositoriesPayload {
  action: 'added' | 'removed';
  installation: { id: number; account: { login: string; id: number } };
  repositories_added?: Array<{ full_name: string; private: boolean }>;
  repositories_removed?: Array<{ full_name: string; private: boolean }>;
}

export class GitHubAppService {
  private deliveriesCollection: Collection<{
    _id: string;
    deliveredAt: Date;
    event: string;
    expiresAt: Date;
  }>;

  constructor(
    private db: Db,
    private authManager: AuthManager,
    private mcaOAuth: McaOAuth,
    private catalogCollection: Collection<McpCatalogEntry>,
  ) {
    this.deliveriesCollection = db.collection('github_webhook_deliveries');
    // TTL index — webhook deliveries kept 7 days for idempotency.
    this.deliveriesCollection
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
      .catch((err) => console.warn('[GitHubAppService] TTL index create failed:', err));
  }

  // ==========================================================================
  // Install callback (Setup URL after user clicks "Install")
  // ==========================================================================

  /**
   * Persist the `INSTALLATION_ID` after a user completes the install flow.
   * The state was created by `McaOAuth.generateAuthUrl` and tracks
   * `(appId, userId, mcaId)`.
   */
  async handleInstallation(opts: {
    state: string;
    installationId: string;
    setupAction: 'install' | 'update' | string | null;
  }): Promise<{ success: boolean; appId?: string; error?: string }> {
    const stateDoc = await this.mcaOAuth.consumeState(opts.state);
    if (!stateDoc) {
      return { success: false, error: 'Invalid or expired state token' };
    }

    if (stateDoc.provider !== 'github') {
      return { success: false, error: `Unexpected provider for github-app callback: ${stateDoc.provider}` };
    }

    const credentials: Record<string, string | undefined> = {
      INSTALLATION_ID: opts.installationId,
    };

    // Wipe legacy OAuth credentials if the user is migrating from the old flow.
    // The MCA's runtime check (resolveInstallationToken) will then fall through
    // cleanly. We deliberately set them to undefined rather than just adding
    // INSTALLATION_ID so AuthManager.set replaces the stored doc.
    credentials.ACCESS_TOKEN = undefined;
    credentials.REFRESH_TOKEN = undefined;
    credentials.EXPIRY_DATE = undefined;

    await this.authManager.set(stateDoc.userId, stateDoc.appId, stateDoc.mcaId, credentials);
    console.log(
      `[GitHubAppService] Installation ${opts.installationId} stored for app ${stateDoc.appId}`,
    );
    return { success: true, appId: stateDoc.appId };
  }

  // ==========================================================================
  // Webhook handling
  // ==========================================================================

  /**
   * Verify the webhook HMAC SHA-256 signature in the
   * `X-Hub-Signature-256: sha256=<hex>` header.
   *
   * Uses `timingSafeEqual` AFTER a length guard — `timingSafeEqual` itself
   * throws on length mismatch, leaking the size of the expected digest.
   */
  static verifyWebhookSignature(
    rawBody: Buffer,
    signatureHeader: string | undefined,
    secret: string,
  ): boolean {
    if (!signatureHeader || !secret) return false;
    const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    const a = Buffer.from(expected);
    const b = Buffer.from(signatureHeader);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /**
   * Has this delivery already been processed? Idempotency by `X-GitHub-Delivery` GUID.
   * Returns `true` if it was a duplicate (caller should still respond 200).
   */
  async isDuplicateDelivery(deliveryId: string, eventType: string): Promise<boolean> {
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    try {
      await this.deliveriesCollection.insertOne({
        _id: deliveryId,
        deliveredAt: new Date(),
        event: eventType,
        expiresAt,
      });
      return false;
    } catch (err) {
      // Duplicate key — already processed.
      if ((err as { code?: number })?.code === 11000) return true;
      throw err;
    }
  }

  /**
   * Process an `installation` webhook event. Updates the persisted
   * `INSTALLATION_ID` for affected users.
   *
   * The mapping between a GitHub `installation.account.login` and a Teros
   * `userId` is the install-time pairing established by `handleInstallation`.
   * Subsequent webhook lifecycle events look up the credentials by
   * `INSTALLATION_ID` value — so the user must have completed the flow at
   * least once before lifecycle events apply.
   */
  async processInstallationEvent(payload: InstallationPayload): Promise<void> {
    const installationId = String(payload.installation.id);

    switch (payload.action) {
      case 'created':
        // Pairing happens via `handleInstallation` (the Setup URL callback).
        // We log but do not act — the credential write happens there.
        console.log(
          `[GitHubAppService] installation.created received for ${payload.installation.account.login} (id=${installationId})`,
        );
        break;

      case 'deleted':
        // The installation is gone — clear the INSTALLATION_ID so subsequent
        // tool calls fail cleanly with APP_NOT_INSTALLED.
        await this.clearInstallationFromCredentials(installationId);
        console.log(
          `[GitHubAppService] installation.deleted — cleared INSTALLATION_ID ${installationId}`,
        );
        break;

      case 'suspend':
      case 'unsuspend':
        // We don't store a separate "suspended" flag — the next API call will
        // hit a 403 and surface to the user via the existing error mapping.
        console.log(
          `[GitHubAppService] installation.${payload.action} — id=${installationId}`,
        );
        break;

      case 'new_permissions_accepted':
        console.log(
          `[GitHubAppService] installation.new_permissions_accepted — id=${installationId}`,
        );
        break;

      default:
        console.log(
          `[GitHubAppService] installation event with unhandled action: ${payload.action}`,
        );
    }
  }

  /**
   * Process `installation_repositories` events. We don't persist the repo
   * list (the MCA queries it on demand via `GET /installation/repositories`)
   * — log only.
   */
  processInstallationRepositoriesEvent(payload: InstallationRepositoriesPayload): void {
    const added = payload.repositories_added?.length ?? 0;
    const removed = payload.repositories_removed?.length ?? 0;
    console.log(
      `[GitHubAppService] installation_repositories.${payload.action} — id=${payload.installation.id}, +${added}/-${removed}`,
    );
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  /**
   * Clear `INSTALLATION_ID` from any user credential that referenced it.
   * Required when the installation is deleted server-side (not by us).
   *
   * O(N) on user_credentials with that mcaId — for the dataset sizes of an
   * alpha product this is fine; if it grows, add an index on
   * `decryptedView.INSTALLATION_ID` materialized at write time.
   */
  private async clearInstallationFromCredentials(installationId: string): Promise<void> {
    const docs = await this.db
      .collection('user_credentials')
      .find({ mcaId: 'mca.github' })
      .toArray();

    for (const doc of docs) {
      const decrypted = await this.authManager.get(doc.userId, doc.appId);
      if (decrypted?.INSTALLATION_ID === installationId) {
        await this.authManager.set(doc.userId, doc.appId, doc.mcaId, {
          ...decrypted,
          INSTALLATION_ID: undefined,
        });
        console.log(
          `[GitHubAppService] Cleared INSTALLATION_ID for user=${doc.userId} app=${doc.appId}`,
        );
      }
    }
  }
}
