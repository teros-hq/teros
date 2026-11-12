/**
 * Per-user encryption keys (GOV-7).
 *
 * Each user has a random master key, stored wrapped (encrypted) with the
 * system key; user secrets (app credentials, provider API keys) are encrypted
 * with it. Deleting a user's key crypto-shreds their secrets.
 *
 * This module replaces two literal copies of the same code (AuthManager and
 * ProviderService) and adds:
 *  - System key versions: the `encryption` secret's `masterKey` is version 1;
 *    `keys: { "<n>": "<hex>" }` + `currentVersion` add more. Each wrapped key
 *    records the version that wrapped it (keyVersion), so the system key can
 *    be rotated by re-wrapping (rewrapUserKeys) without touching user data.
 *  - AAD: new ciphertexts are bound to their owner and purpose
 *    (`teros:<userId>:<scope>`), so a blob copied to another user's or app's
 *    record fails to decrypt. Records written before carry no format marker
 *    and are read the old way.
 *  - The unused salt is no longer generated.
 */

import { type Db, ObjectId } from 'mongodb';
import { isMongoDuplicateKey } from '../lib/mongo-errors.js';
import { secrets } from '../secrets/secrets-manager';
import { decrypt, encrypt, generateKey } from './encryption';
import type { EncryptedData, UserEncryptionKeyDocument } from './types';

/** encryptionFormat of records encrypted with AAD. Absent = legacy (no AAD). */
export const AAD_FORMAT = 2;

interface SystemKeys {
  current: number;
  byVersion: Map<number, Buffer>;
}

function systemKeys(): SystemKeys {
  const secret = secrets.requireSystem('encryption') as {
    masterKey: string;
    keys?: Record<string, string>;
    currentVersion?: number;
  };
  const byVersion = new Map<number, Buffer>([[1, Buffer.from(secret.masterKey, 'hex')]]);
  for (const [version, hex] of Object.entries(secret.keys ?? {})) byVersion.set(Number(version), Buffer.from(hex, 'hex'));
  const current = secret.currentVersion ?? 1;
  if (!byVersion.has(current)) throw new Error(`encryption secret: currentVersion ${current} has no key`);
  return { current, byVersion };
}

function systemKey(version: number): Buffer {
  const key = systemKeys().byVersion.get(version);
  if (!key) throw new Error(`encryption secret: no system key for version ${version}`);
  return key;
}

/** Wrap a user master key: encrypted data ‖ iv ‖ tag, hex. */
function wrap(masterKey: Buffer, version: number): string {
  const e = encrypt(masterKey.toString('hex'), systemKey(version));
  return Buffer.concat([Buffer.from(e.data, 'hex'), Buffer.from(e.iv, 'hex'), Buffer.from(e.tag, 'hex')]).toString('hex');
}

function unwrap(wrapped: string, version: number): Buffer {
  const combined = Buffer.from(wrapped, 'hex');
  const dataLength = combined.length - 32; // iv 16 + tag 16
  const hex = decrypt(
    {
      data: combined.subarray(0, dataLength).toString('hex'),
      iv: combined.subarray(dataLength, dataLength + 16).toString('hex'),
      tag: combined.subarray(dataLength + 16).toString('hex'),
    },
    systemKey(version),
  );
  return Buffer.from(hex, 'hex');
}

/** The user's master key, created on first use. */
export async function getUserKey(db: Db, userId: string): Promise<Buffer> {
  const keys = db.collection<UserEncryptionKeyDocument>('user_encryption_keys');
  const existing = await keys.findOne({ userId });
  if (existing) return unwrap(existing.encryptedMasterKey, existing.keyVersion ?? 1);

  const masterKey = generateKey();
  const version = systemKeys().current;
  try {
    await keys.insertOne({
      _id: new ObjectId(),
      userId,
      encryptedMasterKey: wrap(masterKey, version),
      keyVersion: version,
      createdAt: new Date(),
    });
  } catch (err) {
    // First use from two requests at once: the other one stored its key first
    // (unique userId). Use the stored key, or data encrypted with ours would be
    // unreadable (MOD-5).
    if (!isMongoDuplicateKey(err)) throw err;
    const winner = await keys.findOne({ userId });
    if (!winner) throw err;
    return unwrap(winner.encryptedMasterKey, winner.keyVersion ?? 1);
  }
  return masterKey;
}

const aadFor = (userId: string, scope: string) => `teros:${userId}:${scope}`;

/** Encrypt user data bound to (userId, scope). Store `encryptionFormat: AAD_FORMAT` with it. */
export async function encryptForUser(db: Db, userId: string, scope: string, data: unknown): Promise<EncryptedData> {
  return encrypt(data, await getUserKey(db, userId), aadFor(userId, scope));
}

/** Decrypt user data; `format` is the record's encryptionFormat (absent = legacy, no AAD). */
export async function decryptForUser(
  db: Db,
  userId: string,
  scope: string,
  encrypted: EncryptedData,
  format?: number,
): Promise<any> {
  const key = await getUserKey(db, userId);
  return format === AAD_FORMAT ? decrypt(encrypted, key, aadFor(userId, scope)) : decrypt(encrypted, key);
}

/**
 * Re-wrap every user key with the current system key version (rotation).
 * Safe to re-run; returns how many keys were re-wrapped.
 */
export async function rewrapUserKeys(db: Db): Promise<number> {
  const keys = db.collection<UserEncryptionKeyDocument>('user_encryption_keys');
  const current = systemKeys().current;
  let n = 0;
  for await (const doc of keys.find({ keyVersion: { $ne: current } })) {
    const masterKey = unwrap(doc.encryptedMasterKey, doc.keyVersion ?? 1);
    await keys.updateOne(
      { _id: doc._id, keyVersion: doc.keyVersion },
      { $set: { encryptedMasterKey: wrap(masterKey, current), keyVersion: current } },
    );
    n++;
  }
  return n;
}
