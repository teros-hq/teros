/**
 * Helmcode provider integration tests (T6 — Helmcode 6/6).
 *
 * Verifies the full registration surface for the Helmcode provider:
 *   - VALID_PROVIDER_TYPES includes 'helmcode' (add handler accepts it).
 *   - PROVIDER_TYPES_WITHOUT_SECRETS does NOT include 'helmcode' (it's BYOK).
 *   - getActiveModelsByProvider('helmcode') returns exactly 4 models, all with
 *     capabilities.tools === true.
 *   - addProvider without apiKey creates the record without breaking; with
 *     apiKey the secret is encrypted and stored.
 *   - resolveProvider('helmcode') → billing === 'subscription'.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { VALID_PROVIDER_TYPES } from '../../src/handlers/domains/provider/add';
import {
  PROVIDER_TYPES_WITHOUT_SECRETS,
  ProviderService,
} from '../../src/services/provider-service';
import { getActiveModelsByProvider } from '../../src/models/definitions';
import { resolveProvider } from '@teros/shared';
import { InMemoryDb } from './_stripe-test-helpers';
import { secrets } from '../../src/secrets/secrets-manager';

// ─────────────────────────────────────────────────────────────────────────────
// Inject the system encryption key into the real secrets manager so encryption
// works in tests, and put things back afterwards. (A mock.module here was
// process-global in bun:test and replaced the secrets manager for every test
// file that ran later.)
// ─────────────────────────────────────────────────────────────────────────────
const REAL_MASTER_KEY = 'a'.repeat(64); // 32 bytes in hex
const secretsInternals = secrets as unknown as { loaded: boolean; systemSecrets: Map<string, unknown> };
let originalLoaded: boolean;
let originalEncryption: unknown;

beforeAll(() => {
  originalLoaded = secretsInternals.loaded;
  originalEncryption = secretsInternals.systemSecrets.get('encryption');
  secretsInternals.loaded = true;
  secretsInternals.systemSecrets.set('encryption', { masterKey: REAL_MASTER_KEY });
});

afterAll(() => {
  secretsInternals.loaded = originalLoaded;
  if (originalEncryption) secretsInternals.systemSecrets.set('encryption', originalEncryption);
  else secretsInternals.systemSecrets.delete('encryption');
});

// ─────────────────────────────────────────────────────────────────────────────
// Static registry assertions (no DB needed)
// ─────────────────────────────────────────────────────────────────────────────

describe('Helmcode provider — static registry', () => {
  it('VALID_PROVIDER_TYPES includes helmcode', () => {
    expect(VALID_PROVIDER_TYPES).toContain('helmcode');
  });

  it('PROVIDER_TYPES_WITHOUT_SECRETS does NOT include helmcode (BYOK)', () => {
    expect(PROVIDER_TYPES_WITHOUT_SECRETS as readonly string[]).not.toContain('helmcode');
  });

  it('resolveProvider(helmcode) → billing === subscription', () => {
    const meta = resolveProvider('helmcode');
    expect(meta.id).toBe('helmcode');
    expect(meta.billing).toBe('subscription');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Model catalogue assertions
// ─────────────────────────────────────────────────────────────────────────────

describe('Helmcode model catalogue', () => {
  it('getActiveModelsByProvider(helmcode) returns exactly 4 models', () => {
    const models = getActiveModelsByProvider('helmcode');
    expect(models.length).toBe(4);
  });

  it('all 4 models have capabilities.tools === true', () => {
    const models = getActiveModelsByProvider('helmcode');
    for (const m of models) {
      expect(m.capabilities.tools).toBe(true);
    }
  });

  it('all 4 models have billingType subscription and status active', () => {
    const models = getActiveModelsByProvider('helmcode');
    for (const m of models) {
      expect(m.billingType).toBe('subscription');
      expect(m.status).toBe('active');
    }
  });

  it('modelIds are the expected 4', () => {
    const models = getActiveModelsByProvider('helmcode');
    const ids = models.map((m) => m.modelId).sort();
    expect(ids).toEqual([
      'helmcode-deepseek-v4-flash',
      'helmcode-gemma4',
      'helmcode-glm-5.3',
      'helmcode-qwen3.6',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ProviderService.addProvider — BYOK behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('ProviderService.addProvider — helmcode BYOK', () => {
  it('creates a provider without apiKey (no encryption needed)', async () => {
    const db = new InMemoryDb();
    const svc = new ProviderService(db as any);

    const provider = await svc.addProvider('user_1', {
      providerType: 'helmcode',
      displayName: 'Helmcode',
    });

    expect(provider.providerType).toBe('helmcode');
    expect(provider.displayName).toBe('Helmcode');
    expect(provider.status).toBe('active');
    expect(provider.encryptedData).toBeUndefined();
    expect(provider.encryptionIv).toBeUndefined();
    expect(provider.encryptionTag).toBeUndefined();

    // Persisted
    const stored = await db
      .collection('user_providers')
      .findOne({ userId: 'user_1', providerType: 'helmcode' });
    expect(stored).not.toBeNull();
    expect(stored?.providerType).toBe('helmcode');
  });

  it('with apiKey — encrypts and stores the secret', async () => {
    const db = new InMemoryDb();
    const svc = new ProviderService(db as any);

    const provider = await svc.addProvider('user_1', {
      providerType: 'helmcode',
      displayName: 'Helmcode',
      auth: { apiKey: 'hc-test-key-12345' },
    });

    // The provider record itself doesn't carry the encrypted fields —
    // setProviderSecrets updates the DB record after insertOne.
    expect(provider.providerType).toBe('helmcode');

    // The stored record should have encrypted fields populated.
    const stored = await db
      .collection('user_providers')
      .findOne({ providerId: provider.providerId });
    expect(stored).not.toBeNull();
    expect(stored?.encryptedData).toBeTruthy();
    expect(stored?.encryptionIv).toBeTruthy();
    expect(stored?.encryptionTag).toBeTruthy();

    // The encrypted data must NOT contain the raw API key in plaintext.
    expect(JSON.stringify(stored)).not.toContain('hc-test-key-12345');

    // Decrypt round-trip: getProviderSecrets should return the original key.
    const secrets = await svc.getProviderSecrets('user_1', provider.providerId);
    expect(secrets?.apiKey).toBe('hc-test-key-12345');
  });
});
