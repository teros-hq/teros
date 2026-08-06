/**
 * GitHub Webhook Handler — `POST /webhooks/github`.
 *
 * Receives webhook deliveries from the Teros GitHub App and dispatches
 * `installation` / `installation_repositories` events to the
 * `GitHubAppService`. Verifies the HMAC SHA-256 signature in
 * `X-Hub-Signature-256` against `GITHUB_APP_WEBHOOK_SECRET` from the system
 * secrets store. Idempotency keyed by the `X-GitHub-Delivery` GUID.
 *
 * Responds 200 within <1s — heavy work is deferred to a `setImmediate`
 * tail since GitHub's webhook delivery timeout is 10s and we don't want
 * a slow DB write to drop a delivery.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { GitHubAppService } from '../auth/github-app';
import type { SecretsManager } from '../secrets/secrets-manager';

const MCA_GITHUB_ID = 'mca.github';

export class GitHubWebhookHandler {
  constructor(
    private githubAppService: GitHubAppService,
    private secretsManager: SecretsManager,
  ) {}

  async handleRoute(req: IncomingMessage, res: ServerResponse, url: string): Promise<boolean> {
    if (url !== '/webhooks/github') return false;
    if (req.method !== 'POST') {
      this.sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }
    await this.handle(req, res);
    return true;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const eventType = String(req.headers['x-github-event'] ?? '');
    const deliveryId = String(req.headers['x-github-delivery'] ?? '');
    const signature = req.headers['x-hub-signature-256'];

    if (!eventType || !deliveryId) {
      this.sendJson(res, 400, { error: 'Missing X-GitHub-Event or X-GitHub-Delivery header' });
      return;
    }

    // Read raw body — must NOT JSON.parse before HMAC verify.
    const rawBody = await this.readRawBody(req);

    const secrets = this.secretsManager.mca(MCA_GITHUB_ID);
    const webhookSecret = secrets?.GITHUB_APP_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error('[GitHubWebhookHandler] GITHUB_APP_WEBHOOK_SECRET not configured');
      this.sendJson(res, 500, { error: 'Webhook secret not configured' });
      return;
    }

    if (
      !GitHubAppService.verifyWebhookSignature(
        rawBody,
        Array.isArray(signature) ? signature[0] : signature,
        webhookSecret,
      )
    ) {
      console.warn(
        `[GitHubWebhookHandler] Invalid signature on delivery ${deliveryId} (event=${eventType})`,
      );
      this.sendJson(res, 401, { error: 'Invalid signature' });
      return;
    }

    // Parse payload after verify.
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch (err) {
      this.sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    // Respond 200 immediately. Process async on the tail.
    this.sendJson(res, 200, { ok: true, delivery: deliveryId });

    setImmediate(async () => {
      try {
        const isDup = await this.githubAppService.isDuplicateDelivery(deliveryId, eventType);
        if (isDup) {
          console.log(
            `[GitHubWebhookHandler] Duplicate delivery ${deliveryId} (event=${eventType}) — skipping`,
          );
          return;
        }

        switch (eventType) {
          case 'ping':
            console.log(`[GitHubWebhookHandler] ping received from delivery ${deliveryId}`);
            break;
          case 'installation':
            await this.githubAppService.processInstallationEvent(payload as never);
            break;
          case 'installation_repositories':
            this.githubAppService.processInstallationRepositoriesEvent(payload as never);
            break;
          default:
            console.log(`[GitHubWebhookHandler] Unhandled event type: ${eventType}`);
        }
      } catch (err) {
        console.error(
          `[GitHubWebhookHandler] Async processing error for delivery ${deliveryId}:`,
          err,
        );
      }
    });
  }

  private readRawBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}
