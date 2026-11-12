/**
 * Deterministic password derivation for Teros mailboxes (ported literally
 * from the verified stalwart-tools seed):
 *
 *   password(email) = base62( HMAC-SHA256(masterSecret, 'v1:' + email) )[0:32]
 *
 * - Alphanumeric [A-Za-z0-9], 32 chars (~190 bits of entropy) — passes
 *   Stalwart's password strength policy.
 * - No password storage: any mailbox password can be re-derived on demand.
 * - 'v1:' prefix leaves room for future algorithm versions.
 * - Rotate the master secret + re-run admin-change-password on all accounts
 *   to rotate everything (mailboxes with their own MAIL_PASSWORD are
 *   unaffected).
 */
import { createHmac } from 'node:crypto';

const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Derive the 32-char alphanumeric password for a mailbox address. */
export function derivePassword(email: string, masterSecret: string): string {
  const digest = createHmac('sha256', masterSecret).update('v1:' + email.trim().toLowerCase()).digest('hex');
  let n = BigInt('0x' + digest);
  let out = '';
  while (out.length < 32) {
    out += CHARSET[Number(n % 62n)];
    n /= 62n;
  }
  return out.slice(0, 32);
}
