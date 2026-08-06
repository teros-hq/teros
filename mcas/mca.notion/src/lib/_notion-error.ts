/**
 * Notion API error classification.
 *
 * Maps the SDK's `NotionClientError` taxonomy (APIResponseError +
 * RequestTimeoutError + UnknownHTTPResponseError + InvalidPathParameterError)
 * to a stable `IssueCode` + `IssueAction`. The upstream `message` is preserved
 * verbatim — only the action description is curated per code. Pattern aligned
 * with `_canva-error.ts` and `_figma-error.ts`.
 *
 * Canonical detection uses the SDK's official `isNotionClientError` type
 * guard, exactly as the Notion docs recommend
 * (https://developers.notion.com/reference/handling-errors):
 *
 *   try { … } catch (error: unknown) {
 *     if (isNotionClientError(error)) {
 *       switch (error.code) {
 *         case APIErrorCode.Unauthorized: …
 *         case APIErrorCode.ObjectNotFound: …
 *       }
 *     }
 *   }
 *
 * Errors that are NOT NotionClientError instances (raw network failures,
 * generic Error throws from upstream helpers, etc.) get a network-pattern
 * fallback over `error.message`. There is no duck-typed `error.code` /
 * `error.status` branch because (a) the docs do not endorse it, (b) any error
 * the SDK throws WILL be a NotionClientError instance in the single-realm
 * Node process the MCA runs in, and (c) accepting plain shape would mask
 * test stubs that fail to mirror production fidelity.
 *
 * The `[CODE]` prefix on `NotionApiError.message` is the workaround for
 * `mca-sdk` only serialising `error.message` to the model
 * (see MCA-DEVELOPMENT.md §14.9). The agent reads the bracketed code to
 * decide whether to reconnect, retry, or surface to the user.
 */

import { APIErrorCode, ClientErrorCode, isNotionClientError } from '@notionhq/client';

export type IssueCode =
  | 'AUTH_EXPIRED'
  | 'AUTH_REQUIRED'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'VALIDATION_ERROR'
  | 'CONFLICT'
  | 'PROVIDER_ERROR'
  | 'NETWORK_ERROR'
  | 'SYSTEM_CONFIG_MISSING';

export interface IssueAction {
  type: 'user_action' | 'admin_action' | 'auto_retry';
  description: string;
}

export interface ClassifiedNotionError {
  code: IssueCode;
  action: IssueAction;
  /** Literal upstream Notion message — never rewritten. */
  message: string;
}

const ACTION_BY_CODE: Record<IssueCode, IssueAction> = {
  AUTH_EXPIRED: {
    type: 'user_action',
    description: 'Reconnect your Notion account — the access token expired or was revoked.',
  },
  AUTH_REQUIRED: {
    type: 'user_action',
    description: 'Connect your Notion account via OAuth.',
  },
  PERMISSION_DENIED: {
    type: 'user_action',
    description:
      'Share the target page or database with the Teros integration in Notion (Page → Connections → Add).',
  },
  NOT_FOUND: {
    type: 'user_action',
    description:
      'Resource not found — verify the UUID or whether it was archived/deleted in Notion.',
  },
  RATE_LIMITED: {
    type: 'auto_retry',
    description: 'Notion rate limit; retry after a short delay.',
  },
  VALIDATION_ERROR: {
    type: 'user_action',
    description: 'Request rejected by Notion — see message for the offending field.',
  },
  CONFLICT: {
    type: 'auto_retry',
    description: 'Concurrent update on the same Notion resource — retry.',
  },
  PROVIDER_ERROR: {
    type: 'auto_retry',
    description: 'Notion API temporarily unavailable.',
  },
  NETWORK_ERROR: {
    type: 'auto_retry',
    description: 'Network error reaching Notion.',
  },
  SYSTEM_CONFIG_MISSING: {
    type: 'admin_action',
    description: 'Configure Notion CLIENT_ID and CLIENT_SECRET in system secrets.',
  },
};

function build(code: IssueCode, message: string): ClassifiedNotionError {
  return { code, action: ACTION_BY_CODE[code], message };
}

/**
 * Map a Notion SDK error `code` (APIErrorCode or ClientErrorCode) to an
 * IssueCode. Pure dispatch; the caller has already verified shape via
 * `isNotionClientError`.
 */
function mapSdkCodeToIssue(code: APIErrorCode | ClientErrorCode): IssueCode {
  switch (code) {
    case APIErrorCode.Unauthorized:
      return 'AUTH_EXPIRED';
    case APIErrorCode.RestrictedResource:
      return 'PERMISSION_DENIED';
    case APIErrorCode.ObjectNotFound:
      return 'NOT_FOUND';
    case APIErrorCode.RateLimited:
      return 'RATE_LIMITED';
    case APIErrorCode.InvalidJSON:
    case APIErrorCode.InvalidRequestURL:
    case APIErrorCode.InvalidRequest:
    case APIErrorCode.ValidationError:
      return 'VALIDATION_ERROR';
    case APIErrorCode.ConflictError:
      return 'CONFLICT';
    case APIErrorCode.InternalServerError:
    case APIErrorCode.ServiceUnavailable:
    case APIErrorCode.GatewayTimeout:
      return 'PROVIDER_ERROR';
    case ClientErrorCode.RequestTimeout:
    case ClientErrorCode.ResponseError:
      return 'NETWORK_ERROR';
    case ClientErrorCode.InvalidPathParameter:
      return 'VALIDATION_ERROR';
    default:
      // Future-proofing: a new SDK enum value lands → degrade gracefully to
      // PROVIDER_ERROR rather than break compile or runtime. TypeScript will
      // still flag the missing case at build time once @notionhq/client bumps.
      return 'PROVIDER_ERROR';
  }
}

const NETWORK_MESSAGE_RE = /ETIMEDOUT|ECONNRESET|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed/i;

/**
 * Classify an error caught from a Notion SDK call (or surrounding code) into
 * a stable IssueCode + IssueAction. Leaves the original upstream message
 * intact.
 *
 * Resolution order:
 *   1. `NotionApiError` (already classified) → pass through.
 *   2. `isNotionClientError(err)` → switch on the SDK's `code` enum.
 *   3. Generic `Error` matching a known network pattern → NETWORK_ERROR.
 *   4. Anything else → PROVIDER_ERROR (with the original message preserved).
 */
export function classifyNotionError(err: unknown): ClassifiedNotionError {
  if (err instanceof NotionApiError) return err.classified;

  if (isNotionClientError(err)) {
    return build(mapSdkCodeToIssue(err.code), err.message);
  }

  const message = err instanceof Error ? err.message : String(err);
  if (NETWORK_MESSAGE_RE.test(message)) {
    return build('NETWORK_ERROR', message);
  }
  return build('PROVIDER_ERROR', message);
}

/**
 * Thrown by `wrapNotionCall` / `wrapNotionWrite` on classified errors, and by
 * `notion-client.ts` when token refresh itself fails (refresh_token revoked,
 * system secrets missing). The constructor prepends `[CODE]` to
 * `error.message` so the agent can route on it — workaround for `mca-sdk`
 * only serialising `error.message` to the model
 * (see MCA-DEVELOPMENT.md §14.9). The upstream Notion message is preserved
 * verbatim in `upstreamMessage` for assertions in app-level catch blocks.
 */
export class NotionApiError extends Error {
  classified: ClassifiedNotionError;
  /** Literal upstream message, without the `[CODE]` prefix. */
  upstreamMessage: string;

  constructor(classified: ClassifiedNotionError) {
    super(`[${classified.code}] ${classified.message}`);
    this.name = 'NotionApiError';
    this.classified = classified;
    this.upstreamMessage = classified.message;
  }
}
