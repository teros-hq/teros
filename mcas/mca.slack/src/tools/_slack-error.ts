/**
 * Slack API error classifier.
 *
 * Maps `(WebAPIPlatformError code, HTTP status)` → `{ IssueCode, IssueAction }`
 * for use in `-health-check` and as the canonical error renderer for tool
 * handlers. Prepends `[CODE]` to `error.message` so the LLM (which only sees
 * `error.message` thanks to the SDK serializer) can branch its retry/reauth
 * logic without parsing free-form English. See
 * `feedback_mca_classify_provider_errors` and `MCA-DEVELOPMENT.md §14.9`.
 *
 * Retry policy is consulted by `wrapSlackCall` and applied ONLY to GET-style
 * (read) handlers. Mutations never retry without an idempotency key — see
 * `feedback_mca_retry_get_only`.
 */

export type IssueCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_INVALID'
  | 'AUTH_EXPIRED'
  | 'SCOPE_MISSING'
  | 'FEATURE_GATED'
  | 'NOT_FOUND'
  | 'CHANNEL_ARCHIVED'
  | 'NOT_IN_CHANNEL'
  | 'NAME_CONFLICT'
  | 'INVALID_NAME'
  | 'INVALID_ARGUMENT'
  | 'BUSINESS_RULE'
  | 'RATE_LIMITED'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'TIMEOUT'
  | 'UNKNOWN';

export interface IssueAction {
  type: 'user_action' | 'admin_action' | 'auto_retry' | 'reconnect';
  description: string;
}

export interface SlackClassifiedError {
  code: IssueCode;
  action: IssueAction;
  retryable: boolean;
  httpStatus: number | null;
  upstreamMessage: string;
}

/**
 * Custom error thrown by `wrapSlackCall` and the tool handlers. Preserves the
 * upstream Slack message verbatim while exposing a structured `code` + bracket
 * prefix for the LLM. Mirror of `mca.figma:figma-client.ts:FigmaApiError`.
 */
export class SlackApiError extends Error {
  readonly code: IssueCode;
  readonly action: IssueAction;
  readonly retryable: boolean;
  readonly httpStatus: number | null;
  readonly upstreamMessage: string;

  constructor(classified: SlackClassifiedError) {
    super(`[${classified.code}] ${classified.upstreamMessage}`);
    this.name = 'SlackApiError';
    this.code = classified.code;
    this.action = classified.action;
    this.retryable = classified.retryable;
    this.httpStatus = classified.httpStatus;
    this.upstreamMessage = classified.upstreamMessage;
  }
}

const AUTH_INVALID_CODES = new Set([
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'token_expired',
  'account_inactive',
  'no_permission',
]);

const SCOPE_MISSING_CODES = new Set([
  'missing_scope',
  'not_allowed_token_type',
  'no_scope',
]);

const NOT_FOUND_CODES = new Set([
  'channel_not_found',
  'user_not_found',
  'message_not_found',
  'file_not_found',
  'team_not_found',
  'usergroup_not_found',
]);

const BUSINESS_RULE_CODES = new Set([
  'cant_invite',
  'cant_invite_self',
  'already_in_channel',
  'already_reacted',
  'no_reaction',
  'cant_archive_general',
  'last_member',
  'channel_not_archived',
  'too_many_members',
  'cant_dm_bot',
  'method_not_supported_for_channel_type',
  // Bot/user lacks permission to perform the action even with the right scope
  // (e.g. rename a channel the bot didn't create). Distinct from missing_scope
  // (scope-level) and FEATURE_GATED (plan-level): this is a per-resource rule.
  'not_authorized',
  // Slack's generic "you can't do this in this context" — covers Free-plan
  // restrictions like share-file-public, and many resource-bound permission
  // denials. Treated as BUSINESS_RULE because the action is not retriable
  // and reconnecting does not help (it's neither scope nor plan-fixable
  // without admin intervention or different inputs).
  'not_allowed',
]);

const INVALID_NAME_CODES = new Set([
  'invalid_name',
  'invalid_name_required',
  'invalid_name_punctuation',
  'invalid_name_maxlength',
  'invalid_name_specials',
]);

const TRANSIENT_CODES = new Set([
  'service_unavailable',
  'internal_error',
  'fatal_error',
  'request_timeout',
]);

/**
 * Plan-gated / feature-gated codes from Slack Web API. These mean the
 * workspace is on a plan that does not include this surface area (Lists,
 * Canvas, Slack Connect, paid-only methods) — the user cannot fix this by
 * reconnecting with more scopes; they need a plan upgrade or admin to
 * enable the feature. Different from `SCOPE_MISSING` (which is solvable by
 * re-OAuth) and `BUSINESS_RULE` (which is a usage problem).
 */
const FEATURE_GATED_CODES = new Set([
  'feature_not_enabled',
  'feature_disabled',
  'not_authed_paid',
  'paid_only',
  'is_paid_team_only',
  'team_not_authorized',
  'team_not_on_enterprise',
  'enterprise_only',
  'org_login_required',
  'team_added_to_org',
  'accesslimited',
  'access_limited',
  'lists_disabled',
  'canvas_disabled',
  'canvases_disabled',
  'restricted_action',
  'restricted_action_read_only_channel',
  'restricted_action_thread_locked',
  'restricted_action_thread_only_channel',
  'restricted_action_non_threadable_channel',
  'restricted_action_non_member',
  'plan_required',
]);

/**
 * SDK wrapper codes (from `@slack/web-api:ErrorCode`). These appear at
 * `err.code` for any error thrown by the SDK — they identify the WRAPPER
 * class, NOT the underlying Slack error. The real Slack code lives at
 * `err.data.error` (for PlatformError + FileUploadInvalidArguments).
 * Filtering these out is critical: prior versions of this classifier read
 * `err.code` first and always saw 'slack_webapi_platform_error', falling
 * back to INVALID_ARGUMENT for every error. See QA report 2026-05-14.
 */
const SDK_WRAPPER_CODES = new Set([
  'slack_webapi_platform_error',
  'slack_webapi_request_error',
  'slack_webapi_http_error',
  'slack_webapi_rate_limited_error',
  'slack_webapi_refresh_failed_error',
  'slack_webapi_file_upload_invalid_args_error',
  'slack_webapi_file_upload_read_file_data_error',
]);

function extractSlackErrorCode(err: unknown): {
  slackCode: string;
  httpStatus: number | null;
  message: string;
  needed: string;
  provided: string;
} {
  const fallback = {
    slackCode: '',
    httpStatus: null as number | null,
    message: '',
    needed: '',
    provided: '',
  };
  if (!err) return fallback;
  if (typeof err === 'string') return { ...fallback, message: err };
  if (typeof err !== 'object') return fallback;

  const e = err as Record<string, unknown>;
  // WebAPIHTTPError stashes the response body at `e.body`. PlatformError uses
  // `e.data`. We try both.
  const data = (e.data ?? e.body ?? {}) as Record<string, unknown>;
  const headers = (e.headers ?? {}) as Record<string, unknown>;
  const responseMetadata = (data.response_metadata ?? {}) as Record<string, unknown>;
  const wrapperCode = typeof e.code === 'string' ? (e.code as string) : '';

  // Real Slack error code: prefer the body field `error` (the actual API code
  // like missing_scope, feature_not_enabled, channel_not_found, etc.). Only
  // fall back to `err.code` when it is NOT one of the SDK wrapper constants.
  let slackCode = '';
  if (typeof data.error === 'string' && data.error) {
    slackCode = data.error;
  } else if (wrapperCode && !SDK_WRAPPER_CODES.has(wrapperCode)) {
    slackCode = wrapperCode;
  }

  // WebAPIRateLimitedError has no data.error, just a numeric `retryAfter`.
  // Detect it via wrapper code or the presence of retryAfter.
  if (
    !slackCode &&
    (wrapperCode === 'slack_webapi_rate_limited_error' || typeof e.retryAfter === 'number')
  ) {
    slackCode = 'ratelimited';
  }

  // HTTP status: WebAPIHTTPError uses `statusCode`; some shapes use `status`.
  // PlatformError has neither — Slack platform errors come over HTTP 200 with
  // ok:false in the body.
  const httpStatus =
    typeof e.statusCode === 'number'
      ? (e.statusCode as number)
      : typeof e.status === 'number'
        ? (e.status as number)
        : null;

  const message = typeof e.message === 'string' ? (e.message as string) : '';

  // `needed` and `provided` for missing_scope. Slack populates these in three
  // shapes:
  //   1. Legacy: `data.needed` / `data.provided` as comma-separated strings
  //      (still returned at the body root for older endpoints).
  //   2. Modern: `data.response_metadata.acceptedScopes` / `.scopes` as
  //      arrays — the SDK builds these from x-accepted-oauth-scopes and
  //      x-oauth-scopes response headers.
  //   3. Raw fetch: the headers themselves (when callers bypass the SDK).
  const acceptedScopes = Array.isArray(responseMetadata.acceptedScopes)
    ? (responseMetadata.acceptedScopes as unknown[]).filter((s): s is string => typeof s === 'string')
    : null;
  const scopesArr = Array.isArray(responseMetadata.scopes)
    ? (responseMetadata.scopes as unknown[]).filter((s): s is string => typeof s === 'string')
    : null;

  const needed =
    (typeof data.needed === 'string' && data.needed) ||
    (typeof responseMetadata.needed === 'string' && responseMetadata.needed) ||
    (acceptedScopes && acceptedScopes.length > 0 ? acceptedScopes.join(', ') : '') ||
    (typeof headers['x-accepted-oauth-scopes'] === 'string' &&
      (headers['x-accepted-oauth-scopes'] as string)) ||
    (typeof headers['x-oauth-scopes-needed'] === 'string' &&
      (headers['x-oauth-scopes-needed'] as string)) ||
    '';
  const provided =
    (typeof data.provided === 'string' && data.provided) ||
    (typeof responseMetadata.provided === 'string' && responseMetadata.provided) ||
    (scopesArr && scopesArr.length > 0 ? scopesArr.join(', ') : '') ||
    (typeof headers['x-oauth-scopes'] === 'string' && (headers['x-oauth-scopes'] as string)) ||
    '';

  return { slackCode, httpStatus, message, needed, provided };
}

/**
 * Classify a thrown error from the Slack Web API SDK or a raw `fetch` call.
 * Always returns a `SlackClassifiedError` — never throws itself. Use the
 * returned `code` to construct a `HealthCheckBuilder.addIssue` or a
 * `SlackApiError` (the latter is what tool handlers should re-throw).
 */
export function classifySlackApiError(err: unknown): SlackClassifiedError {
  const { slackCode, httpStatus, message, needed, provided } = extractSlackErrorCode(err);
  // Enrich the upstream message with `needed`/`provided` when Slack provides
  // them on missing_scope errors. The LLM only sees `error.message`, so the
  // specific scope name (e.g. `pins:write`) needs to land there to be useful.
  const baseUpstream = slackCode || message || 'Unknown Slack error';
  const scopeDetail = needed ? ` (needed: ${needed}${provided ? `, provided: ${provided}` : ''})` : '';
  const upstreamMessage = baseUpstream;

  if (slackCode === 'ratelimited' || slackCode === 'rate_limited' || httpStatus === 429) {
    return {
      code: 'RATE_LIMITED',
      action: {
        type: 'auto_retry',
        description: 'Slack rate-limited the request. Retrying with backoff.',
      },
      retryable: true,
      httpStatus,
      upstreamMessage,
    };
  }

  if (AUTH_INVALID_CODES.has(slackCode)) {
    return {
      code: slackCode === 'token_expired' ? 'AUTH_EXPIRED' : 'AUTH_INVALID',
      action: {
        type: 'reconnect',
        description: 'Reconnect your Slack workspace from app settings.',
      },
      retryable: false,
      httpStatus,
      upstreamMessage,
    };
  }

  if (SCOPE_MISSING_CODES.has(slackCode)) {
    // Some scopes are architecturally unavailable to our OAuth flow regardless
    // of plan or reconnect:
    //   - `admin` and `admin.*` are Slack Enterprise Grid only. Free / Pro /
    //     Business+ workspaces cannot grant them at all.
    //   - `identity.basic` belongs to the "Sign In With Slack" flow, not the
    //     "Add to Slack" flow we use; granting it would require a different
    //     OAuth installation.
    // In both cases telling the user to "reconnect" is misleading — the
    // failure is permanent for this workspace plan / install model. Surface
    // it as FEATURE_GATED so the LLM can communicate that clearly.
    const neededScopes = needed.split(/[\s,]+/).filter(Boolean);
    const isArchitecturallyUnavailable = neededScopes.some(
      (s) => s === 'identity.basic' || s === 'admin' || s.startsWith('admin.'),
    );
    if (isArchitecturallyUnavailable) {
      const first = neededScopes[0];
      const isAdmin = first === 'admin' || first.startsWith('admin.');
      return {
        code: 'FEATURE_GATED',
        action: {
          type: 'admin_action',
          description: isAdmin
            ? `This tool requires the "${first}" scope, which is only granted on Slack Enterprise Grid. Your workspace plan does not support it — reconnecting will not help.`
            : `This tool requires the "${first}" scope, which belongs to the "Sign In With Slack" OAuth flow (different from "Add to Slack"). It cannot be granted to this installation.`,
        },
        retryable: false,
        httpStatus,
        upstreamMessage: `${baseUpstream}${scopeDetail}`,
      };
    }

    return {
      code: 'SCOPE_MISSING',
      action: {
        type: 'reconnect',
        description: needed
          ? `The connected Slack workspace lacks scope "${needed}". Reconnect from app settings and grant this scope.`
          : 'The connected Slack workspace lacks the scope this tool needs. Reconnect with the additional permissions.',
      },
      retryable: false,
      httpStatus,
      upstreamMessage: `${baseUpstream}${scopeDetail}`,
    };
  }

  if (FEATURE_GATED_CODES.has(slackCode)) {
    return {
      code: 'FEATURE_GATED',
      action: {
        type: 'admin_action',
        description:
          'Slack workspace plan or admin policy does not enable this feature. Upgrade the plan or have a workspace admin enable it. Reconnecting will not help.',
      },
      retryable: false,
      httpStatus,
      upstreamMessage,
    };
  }

  if (slackCode === 'is_archived') {
    return {
      code: 'CHANNEL_ARCHIVED',
      action: {
        type: 'user_action',
        description: 'Channel is archived. Unarchive it before posting or modifying.',
      },
      retryable: false,
      httpStatus,
      upstreamMessage,
    };
  }

  if (slackCode === 'not_in_channel') {
    return {
      code: 'NOT_IN_CHANNEL',
      action: {
        type: 'user_action',
        description: 'The bot is not a member of this channel. Invite it first.',
      },
      retryable: false,
      httpStatus,
      upstreamMessage,
    };
  }

  if (slackCode === 'name_taken') {
    return {
      code: 'NAME_CONFLICT',
      action: {
        type: 'user_action',
        description: 'A channel with this name already exists. Choose a different name.',
      },
      retryable: false,
      httpStatus,
      upstreamMessage,
    };
  }

  if (INVALID_NAME_CODES.has(slackCode)) {
    return {
      code: 'INVALID_NAME',
      action: {
        type: 'user_action',
        description:
          'Channel name must be lowercase, ≤80 chars, no spaces or punctuation other than - and _.',
      },
      retryable: false,
      httpStatus,
      upstreamMessage,
    };
  }

  if (NOT_FOUND_CODES.has(slackCode)) {
    return {
      code: 'NOT_FOUND',
      action: {
        type: 'user_action',
        description: 'Slack returned not_found. Check the id is correct and reachable by the bot.',
      },
      retryable: false,
      httpStatus,
      upstreamMessage,
    };
  }

  if (BUSINESS_RULE_CODES.has(slackCode)) {
    return {
      code: 'BUSINESS_RULE',
      action: {
        type: 'user_action',
        description: 'Slack rejected the operation: ' + slackCode.replace(/_/g, ' '),
      },
      retryable: false,
      httpStatus,
      upstreamMessage,
    };
  }

  if (TRANSIENT_CODES.has(slackCode) || (httpStatus !== null && httpStatus >= 500)) {
    return {
      code: 'DEPENDENCY_UNAVAILABLE',
      action: {
        type: 'auto_retry',
        description: 'Slack API temporarily unavailable. Retry in a few seconds.',
      },
      retryable: true,
      httpStatus,
      upstreamMessage,
    };
  }

  if (
    /ETIMEDOUT|ECONNRESET|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|abort|timeout/i.test(message)
  ) {
    return {
      code: 'TIMEOUT',
      action: {
        type: 'auto_retry',
        description: 'Network timeout reaching Slack API.',
      },
      retryable: true,
      httpStatus,
      upstreamMessage: message || 'Network timeout',
    };
  }

  if (slackCode) {
    return {
      code: 'INVALID_ARGUMENT',
      action: {
        type: 'user_action',
        description: `Slack rejected the request: ${slackCode.replace(/_/g, ' ')}. Verify the arguments — see Slack Web API docs for "${slackCode}".`,
      },
      retryable: false,
      httpStatus,
      upstreamMessage,
    };
  }

  return {
    code: 'UNKNOWN',
    action: {
      type: 'auto_retry',
      description: 'Unclassified Slack error. Retrying once may help.',
    },
    retryable: false,
    httpStatus,
    upstreamMessage,
  };
}

/**
 * Convenience: classify and rethrow as a `SlackApiError`. Use in tool
 * handlers' catch block.
 */
export function throwSlackError(err: unknown): never {
  if (err instanceof SlackApiError) throw err;
  throw new SlackApiError(classifySlackApiError(err));
}
