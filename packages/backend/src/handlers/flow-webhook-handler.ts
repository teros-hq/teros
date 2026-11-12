/**
 * Flow Webhook Handler — `POST /webhooks/flow/:token`
 *
 * Handles incoming webhook requests that trigger flow executions.
 * The URL contains a unique token (not the flowId) for security.
 *
 * Flow:
 *   1. Extract token from URL path
 *   2. Read and parse JSON body
 *   3. Delegate to FlowWebhookService.handleWebhook()
 *   4. Return appropriate HTTP response
 *
 * Rate limiting is handled by the main HTTP handler (rate limiter is applied
 * to all non-exempt paths; /webhooks/flow/* is CSRF-exempt but rate-limited).
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { FlowWebhookService } from '../services/flow-webhook-service';

/** Maximum body size for webhook payloads (1 MB). */
const MAX_BODY_SIZE = 1024 * 1024;

export class FlowWebhookHandler {
  constructor(
    private flowWebhookService: FlowWebhookService,
  ) {}

  async handleRoute(req: IncomingMessage, res: ServerResponse, url: string): Promise<boolean> {
    if (!url.startsWith('/webhooks/flow/')) return false;
    if (req.method !== 'POST') {
      this.sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }

    const token = url.replace('/webhooks/flow/', '').split('?')[0];
    if (!token || token.length < 16) {
      this.sendJson(res, 400, { error: 'Invalid webhook URL' });
      return true;
    }

    await this.handle(req, res, token);
    return true;
  }

  private async handle(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
    // Read raw body with size limit
    const rawBody = await this.readRawBody(req);
    if (rawBody === null) {
      this.sendJson(res, 413, { error: 'Body too large' });
      return;
    }

    // Parse JSON payload
    let payload: unknown;
    try {
      const bodyStr = rawBody.toString('utf8');
      payload = bodyStr.trim() ? JSON.parse(bodyStr) : {};
    } catch {
      this.sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    // Delegate to the service
    const result = await this.flowWebhookService.handleWebhook(token, payload, req.headers);

    this.sendJson(res, result.statusCode, {
      success: result.success,
      ...(result.executionId ? { executionId: result.executionId } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Read the request body with a size limit. Returns null if too large. */
  private readRawBody(req: IncomingMessage): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalSize = 0;
      let tooLarge = false;

      req.on('data', (chunk: Buffer) => {
        if (tooLarge) return;
        totalSize += chunk.length;
        if (totalSize > MAX_BODY_SIZE) {
          tooLarge = true;
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (!tooLarge) resolve(Buffer.concat(chunks));
      });
      req.on('error', reject);
    });
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}
