/**
 * Twilio credential resolution — user-first with system fallback.
 *
 * Model (Pablo, 2026-10-26, same as ElevenLabs ca21e1776): the user can
 * configure their own Twilio account (ACCOUNT_SID + AUTH_TOKEN) as user
 * secrets — buying numbers and sending SMS then happens with THEIR account.
 * System secrets remain as the shared/demo fallback.
 *
 * Twilio uses HTTP Basic Auth with a pair AccountSid:AuthToken — not a
 * single API key. The pair rule below is what makes this file more than a
 * copy of resolveApiKey: a HALF pair must never be used.
 */

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
}

/**
 * Resolve Twilio credentials: user secrets first (per-user account), system
 * secrets as fallback (shared/demo account).
 *
 * FULL-PAIR RULE: Twilio authenticates with AccountSid:AuthToken as one unit.
 * If the user configured only one of the two (e.g. just the SID), we do NOT
 * mix it with the other half from system secrets — SID from account A with a
 * token from account B is a guaranteed Twilio 401. A partial user pair falls
 * through to the complete system pair (or empty credentials if none).
 */
export async function resolveCredentials(context: any): Promise<TwilioCredentials> {
  // user-first: per-user Twilio account (buy numbers, send SMS with THEIR account)
  try {
    const userSecrets = await context.getUserSecrets();
    const sid = userSecrets?.ACCOUNT_SID || userSecrets?.accountSid;
    const token = userSecrets?.AUTH_TOKEN || userSecrets?.authToken;
    if (sid && token) return { accountSid: sid, authToken: token };
  } catch {
    // No user secrets configured (shared app) — fall through to system secrets.
  }
  const secrets = await context.getSystemSecrets();
  return {
    accountSid: secrets.ACCOUNT_SID || secrets.accountSid || '',
    authToken: secrets.AUTH_TOKEN || secrets.authToken || '',
  };
}
