/**
 * Holded API Client
 *
 * Minimal HTTP client for Holded REST API v2 with API key auth.
 * Base URL: https://api.holded.com/api/
 * Auth header: Authorization: Bearer <HOLDED_API_KEY>
 */

import { Buffer } from 'node:buffer';
import type { ToolContext } from '@teros/mca-sdk';

// =============================================================================
// TYPES
// =============================================================================

export interface HoldedSecrets {
  HOLDED_API_KEY?: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const BASE_URL = 'https://api.holded.com/api';
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const RATE_LIMIT_STATUS = 429;

let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 200; // conservative: 5 req/s

// =============================================================================
// UTILITIES
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function respectRateLimit(): Promise<void> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL_MS) {
    await sleep(MIN_REQUEST_INTERVAL_MS - timeSinceLastRequest);
  }
  lastRequestTime = Date.now();
}

function getRetryDelay(attempt: number, retryAfter?: number): number {
  if (retryAfter && retryAfter > 0) {
    return retryAfter * 1000;
  }
  return BASE_DELAY_MS * Math.pow(2, attempt); // 1s, 2s, 4s
}

// =============================================================================
// CLIENT
// =============================================================================

export async function holdedRequest(
  context: ToolContext,
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
    params?: Record<string, string | number | boolean | undefined>;
    skipRateLimit?: boolean;
    responseType?: 'json' | 'arrayBuffer';
  } = {},
): Promise<unknown> {
  const userSecrets = (await context.getUserSecrets()) as HoldedSecrets;
  const apiKey = userSecrets.HOLDED_API_KEY;

  if (!apiKey) {
    throw new Error(
      'Holded API key not configured. Please set your HOLDED_API_KEY in the app settings.',
    );
  }

  const { method = 'GET', body, params, skipRateLimit = false, responseType = 'json' } = options;

  let url = `${BASE_URL}${path}`;

  if (params) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        searchParams.append(key, String(value));
      }
    }
    const qs = searchParams.toString();
    if (qs) url += `?${qs}`;
  }

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (!skipRateLimit) {
        await respectRateLimit();
      }

      const response = await fetch(url, {
        method,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      // Handle rate limiting (429)
      if (response.status === RATE_LIMIT_STATUS) {
        const retryAfterHeader = response.headers.get('Retry-After');
        const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;

        if (attempt < MAX_RETRIES) {
          const delay = getRetryDelay(attempt, retryAfter);
          await sleep(delay);
          continue;
        }
        const errorText = await response.text().catch(() => response.statusText);
        throw new Error(
          `Holded API rate limit exceeded after ${MAX_RETRIES} retries: ${errorText}`,
        );
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        let errorMessage: string;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.message || errorJson.error || errorJson.info || errorText;
        } catch {
          errorMessage = errorText;
        }

        // Retry on 5xx errors
        if (response.status >= 500 && attempt < MAX_RETRIES) {
          const delay = getRetryDelay(attempt);
          await sleep(delay);
          continue;
        }

        throw new Error(`Holded API error ${response.status}: ${errorMessage}`);
      }

      if (response.status === 204) return { success: true };

      if (responseType === 'arrayBuffer') {
        const buffer = await response.arrayBuffer();
        const contentType = response.headers.get('Content-Type') ?? 'application/octet-stream';
        return { buffer, contentType };
      }

      return response.json();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt >= MAX_RETRIES) {
        break;
      }

      if (lastError.message.includes('fetch') || lastError.message.includes('network')) {
        const delay = getRetryDelay(attempt);
        await sleep(delay);
        continue;
      }

      break;
    }
  }

  throw lastError || new Error('Holded API request failed after retries');
}

/**
 * Validate Holded credentials by making a lightweight API call.
 */
export async function validateCredentials(context: ToolContext): Promise<void> {
  await holdedRequest(context, '/v2/contacts', {
    params: { limit: 1 },
    skipRateLimit: true,
  });
}

// =============================================================================
// MULTIPART UPLOAD
// =============================================================================

/** Max attachment size accepted by Holded's upload endpoints (10 MB). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Upload a file to a Holded endpoint as multipart/form-data.
 *
 * `holdedRequest` only speaks JSON — attachments need a real multipart body
 * with the file under the `file` field (NOT JSON, NOT base64). The Buffer is
 * wrapped in a Blob because Node 18+ FormData rejects ArrayBufferView
 * (same lesson as the Notion MCA's upload-file).
 *
 * Size is validated BEFORE the upload so an oversized file fails fast
 * client-side instead of after a 10MB transfer.
 */
export async function holdedUpload(
  context: ToolContext,
  path: string,
  file: { data: Uint8Array | ArrayBuffer; filename: string; contentType: string },
): Promise<unknown> {
  const userSecrets = (await context.getUserSecrets()) as HoldedSecrets;
  const apiKey = userSecrets.HOLDED_API_KEY;

  if (!apiKey) {
    throw new Error(
      'Holded API key not configured. Please set your HOLDED_API_KEY in the app settings.',
    );
  }

  const bytes = Buffer.from(
    file.data instanceof Uint8Array ? (file.data as unknown as ArrayBufferLike) : file.data,
  );
  if (bytes.byteLength === 0) {
    throw new Error('Cannot attach an empty file.');
  }
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `File too large (${(bytes.byteLength / (1024 * 1024)).toFixed(2)} MB). Holded attachments are capped at 10 MB.`,
    );
  }

  const form = new FormData();
  // Copy into a plain ArrayBuffer — Buffer/Uint8Array<ArrayBufferLike> is not
  // assignable to BlobPart under strict TS (the Notion MCA lives with the same
  // error; we don't have to).
  const arrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const blob = new Blob([arrayBuffer], { type: file.contentType });
  form.append('file', blob, file.filename);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await respectRateLimit();

      const response = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        body: form,
      });

      if (response.status === RATE_LIMIT_STATUS) {
        const retryAfterHeader = response.headers.get('Retry-After');
        const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;
        if (attempt < MAX_RETRIES) {
          await sleep(getRetryDelay(attempt, retryAfter));
          continue;
        }
        const errorText = await response.text().catch(() => response.statusText);
        throw new Error(`Holded API rate limit exceeded after ${MAX_RETRIES} retries: ${errorText}`);
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        let errorMessage: string;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.message || errorJson.error || errorJson.info || errorText;
        } catch {
          errorMessage = errorText;
        }

        if (response.status >= 500 && attempt < MAX_RETRIES) {
          await sleep(getRetryDelay(attempt));
          continue;
        }

        throw new Error(`Holded API error ${response.status}: ${errorMessage}`);
      }

      if (response.status === 204) return { success: true };

      const text = await response.text();
      if (!text) return { success: true };
      try {
        return JSON.parse(text);
      } catch {
        return { success: true, raw: text };
      }
    } catch (error) {
      // Uploads are not idempotent — never auto-retry a request that may
      // have already created the attachment server-side. Surface the error
      // to the caller (and the agent) immediately.
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  throw new Error('Holded API upload failed');
}
