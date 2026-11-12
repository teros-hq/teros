/**
 * resolveCredentials — user-first with system fallback (Pablo, 2026-10-26;
 * same model as ElevenLabs ca21e1776, adapted to Twilio's credential PAIR).
 *
 * Twilio authenticates with AccountSid:AuthToken (HTTP Basic) as ONE unit:
 * the full-pair rule is the Twilio-specific part — a half-configured user
 * pair must fall through to the complete system pair, never mix halves from
 * two different accounts (that is a guaranteed Twilio 401).
 */

import { describe, expect, it } from 'bun:test';
import { resolveCredentials } from '../src/credentials';

function makeContext(opts: {
  user?: Record<string, string>;
  userThrows?: boolean;
  system?: Record<string, string>;
}) {
  return {
    getUserSecrets: async () => {
      if (opts.userThrows) throw new Error('no user secrets for this app');
      return opts.user ?? {};
    },
    getSystemSecrets: async () => opts.system ?? {},
  };
}

describe('resolveCredentials', () => {
  it('uses the user pair when both SID and TOKEN are configured (user-first)', async () => {
    const creds = await resolveCredentials(
      makeContext({
        user: { ACCOUNT_SID: 'ACuser123', AUTH_TOKEN: 'user-token' },
        system: { ACCOUNT_SID: 'ACsys456', AUTH_TOKEN: 'sys-token' },
      }),
    );
    expect(creds).toEqual({ accountSid: 'ACuser123', authToken: 'user-token' });
  });

  it('accepts camelCase user keys (accountSid/authToken), mirroring the system path', async () => {
    const creds = await resolveCredentials(
      makeContext({
        user: { accountSid: 'ACuser123', authToken: 'user-token' },
        system: { ACCOUNT_SID: 'ACsys456', AUTH_TOKEN: 'sys-token' },
      }),
    );
    expect(creds).toEqual({ accountSid: 'ACuser123', authToken: 'user-token' });
  });

  it('falls back to the system pair when the user has no secrets', async () => {
    const creds = await resolveCredentials(
      makeContext({ user: {}, system: { ACCOUNT_SID: 'ACsys456', AUTH_TOKEN: 'sys-token' } }),
    );
    expect(creds).toEqual({ accountSid: 'ACsys456', authToken: 'sys-token' });
  });

  it('falls back to the system pair when getUserSecrets throws (shared app)', async () => {
    const creds = await resolveCredentials(
      makeContext({
        userThrows: true,
        system: { ACCOUNT_SID: 'ACsys456', AUTH_TOKEN: 'sys-token' },
      }),
    );
    expect(creds).toEqual({ accountSid: 'ACsys456', authToken: 'sys-token' });
  });

  it('FULL-PAIR RULE: partial user pair (SID only) falls back to the complete system pair', async () => {
    const creds = await resolveCredentials(
      makeContext({
        user: { ACCOUNT_SID: 'ACuser123' }, // AUTH_TOKEN missing
        system: { ACCOUNT_SID: 'ACsys456', AUTH_TOKEN: 'sys-token' },
      }),
    );
    expect(creds).toEqual({ accountSid: 'ACsys456', authToken: 'sys-token' });
  });

  it('FULL-PAIR RULE: partial user pair (TOKEN only) also falls back to system', async () => {
    const creds = await resolveCredentials(
      makeContext({
        user: { AUTH_TOKEN: 'user-token' }, // ACCOUNT_SID missing
        system: { ACCOUNT_SID: 'ACsys456', AUTH_TOKEN: 'sys-token' },
      }),
    );
    expect(creds).toEqual({ accountSid: 'ACsys456', authToken: 'sys-token' });
  });

  it('returns empty strings when neither user nor system secrets exist (current behavior)', async () => {
    const creds = await resolveCredentials(makeContext({ user: {}, system: {} }));
    expect(creds).toEqual({ accountSid: '', authToken: '' });
  });

  it('returns empty strings for a partial user pair when system secrets are also missing', async () => {
    const creds = await resolveCredentials(
      makeContext({ user: { ACCOUNT_SID: 'ACuser123' }, system: {} }),
    );
    expect(creds).toEqual({ accountSid: '', authToken: '' });
  });
});
