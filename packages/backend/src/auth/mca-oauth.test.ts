/**
 * Unit tests for OAUTH_PROVIDERS — the registry of provider-specific OAuth
 * hooks. Covers both kinds (`url-based`, `token-inline`) and the three
 * extensibility hooks: `customizeAuthorizeParams`, `extraCredentials`,
 * `getUserInfo`.
 *
 * These tests exist because the registry replaced earlier
 * `if (provider === "slack")` branches scattered across the handler. The
 * shape contract is now the only thing keeping the discriminated flow
 * coherent — break it and any provider silently falls back.
 */

import { describe, expect, test } from 'bun:test';
import type { OAuthTokenResponse } from '@teros/core';
import { OAUTH_PROVIDERS } from './mca-oauth';

describe('OAUTH_PROVIDERS registry', () => {
  test('all entries declare a kind discriminator', () => {
    for (const [name, cfg] of Object.entries(OAUTH_PROVIDERS)) {
      expect(cfg.kind, `provider ${name} missing kind`).toBeDefined();
      expect(['url-based', 'token-inline']).toContain(cfg.kind);
    }
  });

  test('url-based providers expose userInfoUrl and userInfoFields.email', () => {
    for (const [name, cfg] of Object.entries(OAUTH_PROVIDERS)) {
      if (cfg.kind !== 'url-based') continue;
      expect(cfg.userInfoUrl, `provider ${name} missing userInfoUrl`).toMatch(/^https:\/\//);
      expect(cfg.userInfoFields.email, `provider ${name} missing userInfoFields.email`).toBeTruthy();
    }
  });

  test('token-inline providers expose getUserInfo', () => {
    for (const [name, cfg] of Object.entries(OAUTH_PROVIDERS)) {
      if (cfg.kind !== 'token-inline') continue;
      expect(typeof cfg.getUserInfo, `provider ${name} missing getUserInfo`).toBe('function');
    }
  });
});

describe('OAUTH_PROVIDERS.slack', () => {
  const slack = OAUTH_PROVIDERS.slack;
  if (!slack || slack.kind !== 'token-inline') {
    throw new Error('test setup: slack provider must be token-inline');
  }

  describe('customizeAuthorizeParams', () => {
    test('moves scope → user_scope (Slack distinguishes bot vs user scopes)', () => {
      const params = new URLSearchParams({ scope: 'channels:read users:read.email' });
      slack.customizeAuthorizeParams?.(params);
      expect(params.get('scope')).toBeNull();
      expect(params.get('user_scope')).toBe('channels:read users:read.email');
    });

    test('partitions scopes into bot vs user — both kept', () => {
      const params = new URLSearchParams({
        scope:
          'channels:read incoming-webhook users:read commands files:read channels:manage',
      });
      slack.customizeAuthorizeParams?.(params);
      // Bot-only scopes go to `scope=`, user scopes go to `user_scope=`.
      expect(params.get('scope')).toBe(
        'incoming-webhook commands channels:manage',
      );
      expect(params.get('user_scope')).toBe('channels:read users:read files:read');
    });

    test('shared scopes (chat:write, remote_files:read/share) appear in BOTH buckets', () => {
      const params = new URLSearchParams({
        scope: 'chat:write channels:read remote_files:read remote_files:share remote_files:write',
      });
      slack.customizeAuthorizeParams?.(params);
      // chat:write + remote_files:read/share are Bot + User both; mandados en ambos.
      // remote_files:write es BOT_ONLY → solo bot.
      // channels:read es default (user) → solo user.
      expect(params.get('scope')).toBe(
        'chat:write remote_files:read remote_files:share remote_files:write',
      );
      expect(params.get('user_scope')).toBe(
        'chat:write channels:read remote_files:read remote_files:share',
      );
    });

    test('removes scope param when no bot-only scopes present', () => {
      const params = new URLSearchParams({
        scope: 'channels:read users:read files:read',
      });
      slack.customizeAuthorizeParams?.(params);
      expect(params.get('scope')).toBeNull();
      expect(params.get('user_scope')).toBe('channels:read users:read files:read');
    });

    test('preserves a fully user-only scope list verbatim', () => {
      const params = new URLSearchParams({
        scope: 'search:read.public users.profile:read im:history',
      });
      slack.customizeAuthorizeParams?.(params);
      expect(params.get('user_scope')).toBe(
        'search:read.public users.profile:read im:history',
      );
    });

    test('no-op when scope is absent', () => {
      const params = new URLSearchParams({ client_id: 'x', state: 's' });
      slack.customizeAuthorizeParams?.(params);
      expect(params.get('user_scope')).toBeNull();
      expect(params.get('client_id')).toBe('x');
    });
  });

  describe('extraCredentials', () => {
    test('persists DUAL tokens (user + bot) from token response', () => {
      const token = {
        access_token: 'xoxb-bot-token-here',
        token_type: 'bot',
        team: { id: 'T123', name: 'My Workspace' },
        authed_user: { id: 'U456', access_token: 'xoxp-user-token-here' },
      } as unknown as OAuthTokenResponse & Record<string, unknown>;
      const extras = slack.extraCredentials?.(token);
      expect(extras).toEqual({
        TEAM_ID: 'T123',
        TEAM_NAME: 'My Workspace',
        USER_ID: 'U456',
        ACCESS_TOKEN: 'xoxp-user-token-here',
        BOT_ACCESS_TOKEN: 'xoxb-bot-token-here',
      });
    });

    test('ACCESS_TOKEN is user-scoped (authed_user.access_token) — not bot', () => {
      const token = {
        access_token: 'xoxb-bot',
        token_type: 'bot',
        team: { id: 'T1' },
        authed_user: { id: 'U1', access_token: 'xoxp-user' },
      } as unknown as OAuthTokenResponse & Record<string, unknown>;
      const extras = slack.extraCredentials?.(token);
      expect(extras?.ACCESS_TOKEN).toBe('xoxp-user');
      expect(extras?.BOT_ACCESS_TOKEN).toBe('xoxb-bot');
    });

    test('omits BOT_ACCESS_TOKEN when install only granted user scopes', () => {
      // Slack returns access_token: "" or omits it when no bot scopes were requested
      const token = {
        access_token: '',
        token_type: 'user',
        team: { id: 'T1', name: 'Ws' },
        authed_user: { id: 'U1', access_token: 'xoxp-user' },
      } as unknown as OAuthTokenResponse & Record<string, unknown>;
      const extras = slack.extraCredentials?.(token);
      expect(extras?.ACCESS_TOKEN).toBe('xoxp-user');
      expect(extras?.BOT_ACCESS_TOKEN).toBeUndefined();
    });

    test('omits ACCESS_TOKEN when authed_user has no access_token (bot-only install)', () => {
      const token = {
        access_token: 'xoxb-bot',
        token_type: 'bot',
        team: { id: 'T1', name: 'Ws' },
        authed_user: { id: 'U1' },
      } as unknown as OAuthTokenResponse & Record<string, unknown>;
      const extras = slack.extraCredentials?.(token);
      expect(extras?.ACCESS_TOKEN).toBeUndefined();
      expect(extras?.BOT_ACCESS_TOKEN).toBe('xoxb-bot');
      expect(extras?.TEAM_ID).toBe('T1');
    });

    test('returns empty object when token has no team/authed_user', () => {
      const token = {
        access_token: 'x',
        token_type: 'bot',
      } as unknown as OAuthTokenResponse & Record<string, unknown>;
      const extras = slack.extraCredentials?.(token);
      expect(extras).toEqual({});
    });
  });

  describe('getUserInfo', () => {
    test('returns email + real_name when users.info succeeds', async () => {
      const fakeHttp = {
        get: async () => ({
          ok: true,
          user: {
            name: 'antoniorom',
            profile: { email: 'alex@example.com', real_name: 'Alex Doe' },
          },
        }),
      } as unknown as Parameters<typeof slack.getUserInfo>[1];
      const token = {
        access_token: 'xoxb-bot',
        token_type: 'bot',
        team: { id: 'T1', name: 'Acme' },
        authed_user: { id: 'U1', access_token: 'xoxp-user' },
      } as unknown as OAuthTokenResponse & Record<string, unknown>;
      const info = await slack.getUserInfo(token, fakeHttp);
      expect(info).toEqual({ email: 'alex@example.com', name: 'Alex Doe' });
    });

    test('falls back to team.name when users.info has no user id or token', async () => {
      const fakeHttp = {
        get: async () => {
          throw new Error('should not be called');
        },
      } as unknown as Parameters<typeof slack.getUserInfo>[1];
      const token = {
        access_token: 'xoxb-bot',
        token_type: 'bot',
        team: { id: 'T1', name: 'Acme' },
      } as unknown as OAuthTokenResponse & Record<string, unknown>;
      const info = await slack.getUserInfo(token, fakeHttp);
      expect(info).toEqual({ name: 'Acme' });
    });

    test('falls back to team.name when users.info throws', async () => {
      const fakeHttp = {
        get: async () => {
          throw new Error('network down');
        },
      } as unknown as Parameters<typeof slack.getUserInfo>[1];
      const token = {
        access_token: 'xoxb-bot',
        token_type: 'bot',
        team: { id: 'T1', name: 'Acme' },
        authed_user: { id: 'U1', access_token: 'xoxp-user' },
      } as unknown as OAuthTokenResponse & Record<string, unknown>;
      const info = await slack.getUserInfo(token, fakeHttp);
      expect(info).toEqual({ name: 'Acme' });
    });
  });
});

describe('OAUTH_PROVIDERS.google (regression — url-based path still works)', () => {
  const google = OAUTH_PROVIDERS.google;
  if (!google || google.kind !== 'url-based') {
    throw new Error('test setup: google provider must be url-based');
  }

  test('declares email + name fields', () => {
    expect(google.userInfoFields.email).toBe('email');
    expect(google.userInfoFields.name).toBe('name');
  });

  test('requests refresh token (Google-style)', () => {
    expect(google.requestRefreshToken).toBe(true);
  });

  test('does not declare slack-style hooks', () => {
    expect(google.customizeAuthorizeParams).toBeUndefined();
    expect(google.extraCredentials).toBeUndefined();
  });
});
