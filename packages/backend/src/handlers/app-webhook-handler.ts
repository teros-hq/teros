/**
 * App Webhook Handler — `POST /webhooks/apps/:appId`
 *
 * Generic webhook endpoint for per-app webhook deliveries.
 * Each installed app instance gets its own webhook URL:
 *   https://teros.ai/webhooks/apps/<appId>
 *
 * Flow:
 *   1. Extract appId from URL path
 *   2. Look up app in DB → get mcaId
 *   3. Verify webhook signature using MCA system secret (if configured)
 *   4. Parse JSON payload
 *   5. Map external event to internal topic
 *   6. Dispatch via MCAEventSubscriptionService
 *
 * Signature verification supports HMAC-SHA256 (most common).
 * The secret key is read from `.secrets/mcas/<mcaId>/credentials.json`
 * under `WEBHOOK_SECRET`.
 *
 * Topic naming convention:
 *   mcaId "mca.intercom" + event "conversation.user.created"
 *   → topic "intercom.conversation.user.created"
 *
 * @todo alice - 2026.05.21 : add per-MCA signature algorithm config in manifest
 *   (some providers use SHA-1, ed25519, or custom schemes)
 * @todo alice - 2026.05.21 : add idempotency dedup (delivery-id header → DB)
 */

import { createHmac, timingSafeEqual } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import type { McaService } from '../services/mca-service';
import type { MCAEventSubscriptionService } from '../services/mca-event-subscription-service';
import type { SecretsManager } from '../secrets/secrets-manager';

const WEBHOOK_SECRET_KEY = 'WEBHOOK_SECRET';

export class AppWebhookHandler {
  constructor(
    private mcaService: McaService,
    private secretsManager: SecretsManager,
    private mcaEventSubscriptionService: MCAEventSubscriptionService,
  ) {}

  async handleRoute(req: IncomingMessage, res: ServerResponse, url: string): Promise<boolean> {
    if (!url.startsWith('/webhooks/apps/')) return false;
    if (req.method !== 'POST') {
      this.sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }

    const appId = url.replace('/webhooks/apps/', '').split('?')[0];
    if (!appId) {
      this.sendJson(res, 400, { error: 'Missing appId in URL' });
      return true;
    }

    await this.handle(req, res, appId);
    return true;
  }

  private async handle(req: IncomingMessage, res: ServerResponse, appId: string): Promise<void> {
    // 1. Resolve app → mcaId
    const app = await this.mcaService.getApp(appId);
    if (!app) {
      console.warn(`[AppWebhookHandler] App not found: ${appId}`);
      this.sendJson(res, 404, { error: 'App not found' });
      return;
    }

    const mcaId = app.mcaId;

    // 2. Read raw body (must keep buffer for HMAC verify)
    const rawBody = await this.readRawBody(req);

    // 3. Verify signature if a webhook secret is configured for this MCA
    const secrets = this.secretsManager.mca(mcaId);
    const webhookSecret = secrets?.[WEBHOOK_SECRET_KEY];
    if (webhookSecret) {
      const signature =
        req.headers['x-hub-signature-256'] ??
        req.headers['x-webhook-signature'] ??
        req.headers['stripe-signature'];

      if (!signature) {
        console.warn(`[AppWebhookHandler] Missing signature header for app ${appId} (mca=${mcaId})`);
        this.sendJson(res, 401, { error: 'Missing signature header' });
        return;
      }

      const sig = Array.isArray(signature) ? signature[0] : signature;
      if (!this.verifyHmacSha256(rawBody, sig, webhookSecret)) {
        console.warn(`[AppWebhookHandler] Invalid signature for app ${appId} (mca=${mcaId})`);
        this.sendJson(res, 401, { error: 'Invalid signature' });
        return;
      }
    }

    // 4. Parse JSON payload
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch (err) {
      this.sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    // 5. Determine event type
    // Priority: custom header > payload.topic > payload.event > payload.type > 'unknown'
    const eventType =
      this.getHeader(req, 'x-event-type') ??
      this.getHeader(req, 'x-github-event') ??
      this.getHeader(req, 'x-intercom-event') ??
      (typeof payload.topic === 'string' ? payload.topic : undefined) ??
      (typeof payload.event === 'string' ? payload.event : undefined) ??
      (typeof payload.type === 'string' ? payload.type : undefined) ??
      'unknown';

    // 6. Map mcaId to topic prefix
    // "mca.intercom" → "intercom"
    const topicPrefix = mcaId.replace(/^mca\./, '').replace(/\./g, ':');
    const topic = `${topicPrefix}.${eventType}`;

    // 7. Respond 200 immediately (webhooks must ack fast)
    this.sendJson(res, 200, { ok: true, topic, appId, mcaId });

    // 8. Dispatch async (don't block the HTTP response)
    setImmediate(async () => {
      try {
        await this.mcaEventSubscriptionService.dispatch({
          topic,
          payload: {
            ...payload,
            _webhook: {
              appId,
              mcaId,
              eventType,
              receivedAt: new Date().toISOString(),
            },
          },
        });
        console.log(`[AppWebhookHandler] Dispatched ${topic} for app ${appId}`);
      } catch (err) {
        console.error(`[AppWebhookHandler] Dispatch error for ${topic}:`, err);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Signature verification
  // ---------------------------------------------------------------------------

  private verifyHmacSha256(rawBody: Buffer, signature: string, secret: string): boolean {
    // Support "sha256=<hex>" format (GitHub, Intercom) and raw hex
    const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;

    try {
      const sigBuf = Buffer.from(signature, 'utf8');
      const expectedBuf = Buffer.from(expected, 'utf8');
      if (sigBuf.length !== expectedBuf.length) {
        // Try comparing without the "sha256=" prefix
        const rawSig = signature.replace(/^sha256=/, '');
        const rawExpected = expected.replace(/^sha256=/, '');
        const rawSigBuf = Buffer.from(rawSig, 'utf8');
        const rawExpectedBuf = Buffer.from(rawExpected, 'utf8');
        if (rawSigBuf.length === rawExpectedBuf.length) {
          return timingSafeEqual(rawSigBuf, rawExpectedBuf);
        }
        return false;
      }
      return timingSafeEqual(sigBuf, expectedBuf);
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private getHeader(req: IncomingMessage, name: string): string | undefined {
    const val = req.headers[name] ?? req.headers[name.toLowerCase()];
    if (Array.isArray(val)) return val[0];
    return val;
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
