/**
 * Tests for `_slack-error.ts` — error classification + SlackApiError prefix.
 *
 * The MCA SDK only serializes `error.message` to the LLM, so the `[CODE]`
 * prefix is the contract that lets the agent branch on retryability,
 * reauth, etc. (see `feedback_mca_classify_provider_errors`). These tests
 * lock that contract.
 */

import { describe, expect, it } from 'bun:test';
import { classifySlackApiError, SlackApiError } from '../../src/tools/_slack-error';

describe('classifySlackApiError', () => {
  it('maps invalid_auth → AUTH_INVALID with reconnect action', () => {
    const c = classifySlackApiError({ code: 'invalid_auth' });
    expect(c.code).toBe('AUTH_INVALID');
    expect(c.action.type).toBe('reconnect');
    expect(c.retryable).toBe(false);
  });

  it('maps token_expired → AUTH_EXPIRED', () => {
    const c = classifySlackApiError({ code: 'token_expired' });
    expect(c.code).toBe('AUTH_EXPIRED');
  });

  it('maps missing_scope → SCOPE_MISSING with reconnect action', () => {
    const c = classifySlackApiError({ code: 'missing_scope' });
    expect(c.code).toBe('SCOPE_MISSING');
    expect(c.action.type).toBe('reconnect');
  });

  it('enriches SCOPE_MISSING upstreamMessage with data.needed and data.provided', () => {
    const c = classifySlackApiError({
      code: 'missing_scope',
      data: { error: 'missing_scope', needed: 'pins:write', provided: 'chat:write,channels:read' },
    });
    expect(c.code).toBe('SCOPE_MISSING');
    expect(c.upstreamMessage).toContain('pins:write');
    expect(c.upstreamMessage).toContain('chat:write,channels:read');
    expect(c.action.description).toContain('pins:write');
  });

  it('extracts needed from data.response_metadata.needed (Slack SDK shape)', () => {
    const c = classifySlackApiError({
      code: 'missing_scope',
      data: { error: 'missing_scope', response_metadata: { needed: 'reactions:read' } },
    });
    expect(c.upstreamMessage).toContain('reactions:read');
    expect(c.action.description).toContain('reactions:read');
  });

  it('extracts needed from headers.x-oauth-scopes-needed (raw fetch shape)', () => {
    const c = classifySlackApiError({
      code: 'missing_scope',
      headers: {
        'x-oauth-scopes-needed': 'team:read',
        'x-oauth-scopes': 'chat:write',
      },
    });
    expect(c.upstreamMessage).toContain('team:read');
    expect(c.upstreamMessage).toContain('chat:write');
  });

  it('keeps SCOPE_MISSING upstreamMessage unchanged when needed is absent', () => {
    const c = classifySlackApiError({ code: 'missing_scope' });
    expect(c.upstreamMessage).toBe('missing_scope');
    expect(c.action.description).not.toContain('"');
  });

  it('maps feature_not_enabled → FEATURE_GATED with admin_action', () => {
    const c = classifySlackApiError({ code: 'feature_not_enabled' });
    expect(c.code).toBe('FEATURE_GATED');
    expect(c.action.type).toBe('admin_action');
    expect(c.retryable).toBe(false);
  });

  it('maps not_authed_paid → FEATURE_GATED', () => {
    const c = classifySlackApiError({ code: 'not_authed_paid' });
    expect(c.code).toBe('FEATURE_GATED');
  });

  it('maps lists_disabled → FEATURE_GATED (Slack Lists 2024 gating)', () => {
    const c = classifySlackApiError({ code: 'lists_disabled' });
    expect(c.code).toBe('FEATURE_GATED');
  });

  it('maps canvases_disabled → FEATURE_GATED (Canvas 2024 gating)', () => {
    const c = classifySlackApiError({ code: 'canvases_disabled' });
    expect(c.code).toBe('FEATURE_GATED');
  });

  it('maps restricted_action_read_only_channel → FEATURE_GATED', () => {
    const c = classifySlackApiError({ code: 'restricted_action_read_only_channel' });
    expect(c.code).toBe('FEATURE_GATED');
  });

  it('maps org_login_required → FEATURE_GATED', () => {
    const c = classifySlackApiError({ code: 'org_login_required' });
    expect(c.code).toBe('FEATURE_GATED');
  });

  it('SlackApiError bracket prefix uses FEATURE_GATED code', () => {
    const err = new SlackApiError(classifySlackApiError({ code: 'feature_not_enabled' }));
    expect(err.message).toBe('[FEATURE_GATED] feature_not_enabled');
    expect(err.action.type).toBe('admin_action');
  });

  it('INVALID_ARGUMENT description mentions the specific slack code', () => {
    const c = classifySlackApiError({ code: 'invalid_blocks' });
    expect(c.code).toBe('INVALID_ARGUMENT');
    expect(c.action.description).toContain('invalid blocks');
    expect(c.action.description).toContain('invalid_blocks');
  });
});

// ---------------------------------------------------------------------------
// SDK wrapper shapes — these are what `@slack/web-api` actually throws.
// `err.code` is ALWAYS one of the wrapper constants (slack_webapi_*); the
// real Slack code lives at `err.data.error`. These tests lock the contract
// against the SDK source (see node_modules/@slack/web-api/dist/errors.js).
// QA report 2026-05-14 round-2 exposed that the previous classifier ignored
// data.error and saw every error as 'slack_webapi_platform_error' → all
// errors classified as INVALID_ARGUMENT.
// ---------------------------------------------------------------------------

describe('classifySlackApiError — real SDK shapes', () => {
  it('WebAPIPlatformError {missing_scope} → SCOPE_MISSING (not wrapper)', () => {
    const sdkError = {
      message: 'An API error occurred: missing_scope',
      code: 'slack_webapi_platform_error',
      data: {
        ok: false,
        error: 'missing_scope',
        needed: 'pins:write',
        provided: 'chat:write,channels:read',
      },
    };
    const c = classifySlackApiError(sdkError);
    expect(c.code).toBe('SCOPE_MISSING');
    expect(c.upstreamMessage).toContain('pins:write');
    expect(c.action.description).toContain('pins:write');
  });

  it('WebAPIPlatformError {feature_not_enabled} → FEATURE_GATED', () => {
    const sdkError = {
      message: 'An API error occurred: feature_not_enabled',
      code: 'slack_webapi_platform_error',
      data: { ok: false, error: 'feature_not_enabled' },
    };
    const c = classifySlackApiError(sdkError);
    expect(c.code).toBe('FEATURE_GATED');
    expect(c.action.type).toBe('admin_action');
  });

  it('WebAPIPlatformError {channel_not_found} → NOT_FOUND', () => {
    const sdkError = {
      message: 'An API error occurred: channel_not_found',
      code: 'slack_webapi_platform_error',
      data: { ok: false, error: 'channel_not_found' },
    };
    const c = classifySlackApiError(sdkError);
    expect(c.code).toBe('NOT_FOUND');
  });

  it('WebAPIPlatformError {already_in_channel} → BUSINESS_RULE', () => {
    const sdkError = {
      code: 'slack_webapi_platform_error',
      data: { ok: false, error: 'already_in_channel' },
    };
    const c = classifySlackApiError(sdkError);
    expect(c.code).toBe('BUSINESS_RULE');
  });

  it('WebAPIPlatformError {invalid_auth} → AUTH_INVALID', () => {
    const sdkError = {
      code: 'slack_webapi_platform_error',
      data: { ok: false, error: 'invalid_auth' },
    };
    const c = classifySlackApiError(sdkError);
    expect(c.code).toBe('AUTH_INVALID');
  });

  it('extracts needed from response_metadata.acceptedScopes array (SDK populated from x-accepted-oauth-scopes)', () => {
    const sdkError = {
      code: 'slack_webapi_platform_error',
      data: {
        ok: false,
        error: 'missing_scope',
        response_metadata: {
          acceptedScopes: ['users.profile:write'],
          scopes: ['chat:write', 'channels:read'],
        },
      },
    };
    const c = classifySlackApiError(sdkError);
    expect(c.code).toBe('SCOPE_MISSING');
    expect(c.upstreamMessage).toContain('users.profile:write');
    expect(c.upstreamMessage).toContain('chat:write');
    expect(c.action.description).toContain('users.profile:write');
  });

  it('WebAPIRateLimitedError → RATE_LIMITED retryable', () => {
    const sdkError = {
      message: 'A rate-limit has been reached, you may retry this request in 30 seconds',
      code: 'slack_webapi_rate_limited_error',
      retryAfter: 30,
    };
    const c = classifySlackApiError(sdkError);
    expect(c.code).toBe('RATE_LIMITED');
    expect(c.retryable).toBe(true);
  });

  it('WebAPIHTTPError 503 → DEPENDENCY_UNAVAILABLE retryable', () => {
    const sdkError = {
      message: 'An HTTP protocol error occurred: statusCode = 503',
      code: 'slack_webapi_http_error',
      statusCode: 503,
      statusMessage: 'Service Unavailable',
      headers: {},
    };
    const c = classifySlackApiError(sdkError);
    expect(c.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(c.retryable).toBe(true);
  });

  it('WebAPIRequestError (network) with ECONNRESET → TIMEOUT', () => {
    const sdkError = {
      message: 'A request error occurred: ECONNRESET',
      code: 'slack_webapi_request_error',
      original: new Error('ECONNRESET'),
    };
    const c = classifySlackApiError(sdkError);
    expect(c.code).toBe('TIMEOUT');
    expect(c.retryable).toBe(true);
  });

  it('SDK wrapper code without data.error → does NOT leak as slackCode (regression test for QA round-2 bug)', () => {
    // This is the exact bug from the QA report: the wrapper code was leaking
    // as the slackCode, causing it to be treated as an unknown error → fall
    // through to INVALID_ARGUMENT. With the fix, data.error must be the source.
    const sdkError = {
      message: 'An API error occurred: feature_not_enabled',
      code: 'slack_webapi_platform_error',
      data: { ok: false, error: 'feature_not_enabled' },
    };
    const c = classifySlackApiError(sdkError);
    expect(c.code).not.toBe('INVALID_ARGUMENT');
    expect(c.upstreamMessage).not.toContain('slack_webapi_platform_error');
    expect(c.upstreamMessage).toBe('feature_not_enabled');
  });

  it('SlackApiError bracket prefix uses the Slack code, not the SDK wrapper', () => {
    const sdkError = {
      code: 'slack_webapi_platform_error',
      data: { ok: false, error: 'missing_scope' },
    };
    const err = new SlackApiError(classifySlackApiError(sdkError));
    expect(err.message).toBe('[SCOPE_MISSING] missing_scope');
    expect(err.message).not.toContain('slack_webapi');
  });

  it('missing_scope with needed=admin → FEATURE_GATED (Enterprise Grid only)', () => {
    const sdkError = {
      code: 'slack_webapi_platform_error',
      data: { ok: false, error: 'missing_scope', needed: 'admin', provided: 'chat:write' },
    };
    const c = classifySlackApiError(sdkError);
    expect(c.code).toBe('FEATURE_GATED');
    expect(c.action.type).toBe('admin_action');
    expect(c.action.description).toContain('Enterprise Grid');
  });

  it('missing_scope with needed=admin.users:read → FEATURE_GATED', () => {
    const sdkError = {
      code: 'slack_webapi_platform_error',
      data: { ok: false, error: 'missing_scope', needed: 'admin.users:read' },
    };
    const c = classifySlackApiError(sdkError);
    expect(c.code).toBe('FEATURE_GATED');
  });

  it('missing_scope with needed=identity.basic → FEATURE_GATED (Sign In With Slack flow incompatible)', () => {
    const sdkError = {
      code: 'slack_webapi_platform_error',
      data: { ok: false, error: 'missing_scope', needed: 'identity.basic' },
    };
    const c = classifySlackApiError(sdkError);
    expect(c.code).toBe('FEATURE_GATED');
    expect(c.action.description).toContain('Sign In With Slack');
  });

  it('missing_scope with needed=chat:write stays SCOPE_MISSING (normal scope, fixable by reconnect)', () => {
    const sdkError = {
      code: 'slack_webapi_platform_error',
      data: { ok: false, error: 'missing_scope', needed: 'chat:write' },
    };
    const c = classifySlackApiError(sdkError);
    expect(c.code).toBe('SCOPE_MISSING');
    expect(c.action.type).toBe('reconnect');
  });

  it('maps ratelimited → RATE_LIMITED retryable', () => {
    const c = classifySlackApiError({ code: 'ratelimited' });
    expect(c.code).toBe('RATE_LIMITED');
    expect(c.retryable).toBe(true);
  });

  it('maps HTTP 429 → RATE_LIMITED retryable', () => {
    const c = classifySlackApiError({ status: 429 });
    expect(c.code).toBe('RATE_LIMITED');
    expect(c.retryable).toBe(true);
  });

  it('maps HTTP 5xx → DEPENDENCY_UNAVAILABLE retryable', () => {
    const c = classifySlackApiError({ status: 503 });
    expect(c.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(c.retryable).toBe(true);
  });

  it('maps service_unavailable code → DEPENDENCY_UNAVAILABLE retryable', () => {
    const c = classifySlackApiError({ code: 'service_unavailable' });
    expect(c.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(c.retryable).toBe(true);
  });

  it('maps channel_not_found → NOT_FOUND', () => {
    const c = classifySlackApiError({ code: 'channel_not_found' });
    expect(c.code).toBe('NOT_FOUND');
    expect(c.retryable).toBe(false);
  });

  it('maps is_archived → CHANNEL_ARCHIVED', () => {
    const c = classifySlackApiError({ code: 'is_archived' });
    expect(c.code).toBe('CHANNEL_ARCHIVED');
  });

  it('maps not_in_channel → NOT_IN_CHANNEL', () => {
    const c = classifySlackApiError({ code: 'not_in_channel' });
    expect(c.code).toBe('NOT_IN_CHANNEL');
  });

  it('maps name_taken → NAME_CONFLICT', () => {
    const c = classifySlackApiError({ code: 'name_taken' });
    expect(c.code).toBe('NAME_CONFLICT');
  });

  it('maps invalid_name_punctuation → INVALID_NAME', () => {
    const c = classifySlackApiError({ code: 'invalid_name_punctuation' });
    expect(c.code).toBe('INVALID_NAME');
  });

  it('maps already_in_channel → BUSINESS_RULE', () => {
    const c = classifySlackApiError({ code: 'already_in_channel' });
    expect(c.code).toBe('BUSINESS_RULE');
    expect(c.retryable).toBe(false);
  });

  it('maps not_authorized → BUSINESS_RULE (bot/user lacks permission for this resource)', () => {
    const c = classifySlackApiError({
      code: 'slack_webapi_platform_error',
      data: { ok: false, error: 'not_authorized' },
    });
    expect(c.code).toBe('BUSINESS_RULE');
    expect(c.retryable).toBe(false);
  });

  it('maps not_allowed → BUSINESS_RULE (Free-plan action restriction)', () => {
    const c = classifySlackApiError({
      code: 'slack_webapi_platform_error',
      data: { ok: false, error: 'not_allowed' },
    });
    expect(c.code).toBe('BUSINESS_RULE');
    expect(c.retryable).toBe(false);
  });

  it('maps network ECONNRESET → TIMEOUT retryable', () => {
    const c = classifySlackApiError({ message: 'ECONNRESET while talking to slack.com' });
    expect(c.code).toBe('TIMEOUT');
    expect(c.retryable).toBe(true);
  });

  it('falls back to UNKNOWN for empty error', () => {
    const c = classifySlackApiError(null);
    expect(c.code).toBe('UNKNOWN');
  });

  it('extracts code from { data: { error: ... } } shape (Slack body)', () => {
    const c = classifySlackApiError({ data: { error: 'channel_not_found' } });
    expect(c.code).toBe('NOT_FOUND');
  });

  it('preserves the upstream slack code as upstreamMessage', () => {
    const c = classifySlackApiError({ code: 'invalid_auth' });
    expect(c.upstreamMessage).toBe('invalid_auth');
  });
});

describe('SlackApiError', () => {
  it('prefixes message with [CODE] for LLM consumption', () => {
    const err = new SlackApiError(classifySlackApiError({ code: 'invalid_auth' }));
    expect(err.message).toBe('[AUTH_INVALID] invalid_auth');
    expect(err.code).toBe('AUTH_INVALID');
    expect(err.upstreamMessage).toBe('invalid_auth');
  });

  it('preserves retryable flag', () => {
    const ok = new SlackApiError(classifySlackApiError({ code: 'ratelimited' }));
    expect(ok.retryable).toBe(true);
    const bad = new SlackApiError(classifySlackApiError({ code: 'invalid_auth' }));
    expect(bad.retryable).toBe(false);
  });
});
