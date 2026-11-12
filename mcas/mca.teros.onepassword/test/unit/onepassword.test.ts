/**
 * Contract tests for mca.teros.onepassword.
 *
 * Boundary: the official @1password/sdk client — mocked via `setClientFactory`
 * so tests never touch the network (and never even load the real SDK module,
 * since the default factory's dynamic import only runs in production).
 *
 * Covers: missing-token error, list-vaults mapping, list-items (default
 * archived-exclusion + includeArchived), get-item-fields (secret values +
 * section title resolution), and the health-check issue classification.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as lib from '../../src/lib/index.js';
import * as tools from '../../src/tools/index.js';

// =============================================================================
// MOCK CLIENT
// =============================================================================

// biome-ignore lint/suspicious/noExplicitAny: mock SDK client shape
let mockClient: any = null;
let factoryCalls: string[] = [];

beforeEach(() => {
  factoryCalls = [];
  lib.clearClientCache();
  lib.setClientFactory(async (token: string) => {
    factoryCalls.push(token);
    return mockClient;
  });
});

afterEach(() => {
  lib.clearClientCache();
});

// biome-ignore lint/suspicious/noExplicitAny: fake context with the surface used
function ctx(secrets: Record<string, string | undefined> = { OP_SERVICE_ACCOUNT_TOKEN: 'ops_test_token' }): any {
  return { execution: {}, getUserSecrets: async () => secrets };
}

// =============================================================================
// getClient — token resolution
// =============================================================================

describe('getClient — token resolution', () => {
  it('without OP_SERVICE_ACCOUNT_TOKEN → descriptive error, no factory call', async () => {
    await expect(tools.listVaults.handler({}, ctx({}))).rejects.toThrow(
      '1Password Service Account token not configured. Please set your OP_SERVICE_ACCOUNT_TOKEN in the app settings (see the 1Password MCA README for the 3-step setup).',
    );
    expect(factoryCalls).toEqual([]);
  });

  it('caches the client per token — one factory call across two tool invocations', async () => {
    mockClient = {
      vaults: { list: async () => [] },
      items: { list: async () => [], get: async () => ({}) },
    };
    await tools.listVaults.handler({}, ctx());
    await tools.listVaults.handler({}, ctx());
    expect(factoryCalls).toEqual(['ops_test_token']);
  });
});

// =============================================================================
// list-vaults
// =============================================================================

describe('list-vaults', () => {
  it('maps vault overviews to curated output (id, title, description, type, itemCount)', async () => {
    mockClient = {
      vaults: {
        list: async () => [
          {
            id: 'vault_abc123',
            title: 'Teros',
            description: 'Platform secrets',
            vaultType: 'USER_CREATED',
            activeItemCount: 42,
            contentVersion: 7,
            attributeVersion: 2,
            createdAt: new Date('2026-01-01T00:00:00Z'),
            updatedAt: new Date('2026-09-01T00:00:00Z'),
          },
        ],
      },
    };

    const result = (await tools.listVaults.handler({}, ctx())) as {
      vaults: Array<Record<string, unknown>>;
      count: number;
    };

    expect(result.count).toBe(1);
    expect(result.vaults[0]).toEqual({
      id: 'vault_abc123',
      title: 'Teros',
      description: 'Platform secrets',
      vaultType: 'USER_CREATED',
      activeItemCount: 42,
      updatedAt: '2026-09-01T00:00:00.000Z',
    });
  });

  it('empty vault list → count 0, no crash', async () => {
    mockClient = { vaults: { list: async () => [] } };
    const result = (await tools.listVaults.handler({}, ctx())) as { count: number };
    expect(result.count).toBe(0);
  });
});

// =============================================================================
// list-items
// =============================================================================

describe('list-items', () => {
  const items = [
    { id: 'item1', title: 'Deepgram', category: 'ApiCredential', vaultId: 'v1', tags: ['stt'], state: 'ACTIVE', updatedAt: new Date('2026-09-01T00:00:00Z') },
    { id: 'item2', title: 'Old Key', category: 'Login', vaultId: 'v1', tags: [], state: 'ARCHIVED', updatedAt: new Date('2026-08-01T00:00:00Z') },
  ];

  beforeEach(() => {
    mockClient = { items: { list: async () => items } };
  });

  it('default: excludes ARCHIVED items and reports archivedExcluded', async () => {
    const result = (await tools.listItems.handler({ vaultId: 'v1' }, ctx())) as {
      vaultId: string;
      items: Array<{ id: string }>;
      count: number;
      archivedExcluded: boolean;
    };
    expect(result.vaultId).toBe('v1');
    expect(result.items.map((i) => i.id)).toEqual(['item1']);
    expect(result.count).toBe(1);
    expect(result.archivedExcluded).toBe(true);
  });

  it('includeArchived: true → returns everything, archivedExcluded false', async () => {
    const result = (await tools.listItems.handler({ vaultId: 'v1', includeArchived: true }, ctx())) as {
      items: Array<{ id: string }>;
      archivedExcluded: boolean;
    };
    expect(result.items.map((i) => i.id)).toEqual(['item1', 'item2']);
    expect(result.archivedExcluded).toBe(false);
  });

  it('curated item shape: id, title, category, tags, state, updatedAt (ISO)', async () => {
    const result = (await tools.listItems.handler({ vaultId: 'v1' }, ctx())) as {
      items: Array<Record<string, unknown>>;
    };
    expect(result.items[0]).toEqual({
      id: 'item1',
      title: 'Deepgram',
      category: 'ApiCredential',
      tags: ['stt'],
      state: 'ACTIVE',
      updatedAt: '2026-09-01T00:00:00.000Z',
    });
  });
});

// =============================================================================
// get-item-fields — the tool that reads secret values
// =============================================================================

describe('get-item-fields', () => {
  it('returns fields INCLUDING secret values, with section titles resolved', async () => {
    mockClient = {
      items: {
        get: async () => ({
          id: 'item1',
          title: 'Deepgram',
          category: 'ApiCredential',
          vaultId: 'v1',
          fields: [
            { id: 'username', title: 'username', fieldType: 'Text', value: 'pablo' },
            { id: 'credential', title: 'credential', fieldType: 'Concealed', value: 'dg_live_SECRET_KEY_123' },
            { id: 'notesPlain', title: 'notesPlain', fieldType: 'Text', value: '' },
            { id: 'f4', title: 'Project', sectionId: 'sec1', fieldType: 'Text', value: 'voice-mode-v2' },
          ],
          sections: [{ id: 'sec1', title: 'Details' }],
          notes: 'some notes',
          tags: ['stt'],
          version: 3,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-09-01T00:00:00Z'),
        }),
      },
    };

    const result = (await tools.getItemFields.handler({ vaultId: 'v1', itemId: 'item1' }, ctx())) as {
      id: string;
      title: string;
      fields: Array<Record<string, unknown>>;
      hasNotes: boolean;
      version: number;
    };

    expect(result.id).toBe('item1');
    expect(result.title).toBe('Deepgram');
    expect(result.hasNotes).toBe(true);
    expect(result.version).toBe(3);

    // The secret value IS the point of the tool — it must come through
    const credential = result.fields.find((f) => f.id === 'credential');
    expect(credential?.value).toBe('dg_live_SECRET_KEY_123');

    // Section id resolved to its title
    const project = result.fields.find((f) => f.id === 'f4');
    expect(project?.section).toBe('Details');

    // Fields without a section → null
    const username = result.fields.find((f) => f.id === 'username');
    expect(username?.section).toBeNull();
  });

  it('unknown sectionId → falls back to the raw section id', async () => {
    mockClient = {
      items: {
        get: async () => ({
          id: 'item1',
          title: 'X',
          category: 'Login',
          vaultId: 'v1',
          fields: [{ id: 'f1', title: 'F', sectionId: 'ghost', fieldType: 'Text', value: 'v' }],
          sections: [],
          notes: '',
          tags: [],
          version: 1,
        }),
      },
    };
    const result = (await tools.getItemFields.handler({ vaultId: 'v1', itemId: 'item1' }, ctx())) as {
      fields: Array<{ section: string | null }>;
    };
    expect(result.fields[0].section).toBe('ghost');
  });

  it('item with no fields → empty array, no crash', async () => {
    mockClient = {
      items: {
        get: async () => ({
          id: 'item1', title: 'Empty', category: 'SecureNote', vaultId: 'v1',
          fields: [], sections: [], notes: '', tags: [], version: 1,
        }),
      },
    };
    const result = (await tools.getItemFields.handler({ vaultId: 'v1', itemId: 'item1' }, ctx())) as {
      fields: unknown[];
    };
    expect(result.fields).toEqual([]);
  });
});

// =============================================================================
// -health-check
// =============================================================================

describe('-health-check', () => {
  it('missing token → AUTH_REQUIRED issue with user action', async () => {
    const result = (await tools.healthCheck.handler({}, ctx({}))) as {
      status: string;
      issues?: Array<{ code: string; action?: { type: string } }>;
    };
    expect(result.status).toBe('not_ready');
    expect(result.issues?.length).toBe(1);
    expect(result.issues?.[0].code).toBe('AUTH_REQUIRED');
    expect(result.issues?.[0].action?.type).toBe('user_action');
  });

  it('valid token + vaults.list() succeeds → status ready, no issues', async () => {
    mockClient = { vaults: { list: async () => [] } };
    const result = (await tools.healthCheck.handler({}, ctx())) as {
      status: string;
      issues?: unknown[];
    };
    expect(result.status).toBe('ready');
    expect(result.issues).toBeUndefined();
  });

  it('invalid token error → AUTH_INVALID', async () => {
    mockClient = {
      vaults: { list: async () => { throw new Error('service account token had invalid format'); } },
    };
    const result = (await tools.healthCheck.handler({}, ctx())) as {
      status: string;
      issues?: Array<{ code: string }>;
    };
    expect(result.status).toBe('not_ready');
    expect(result.issues?.[0].code).toBe('AUTH_INVALID');
  });

  it('rate limit error → RATE_LIMITED (degraded, auto-retry)', async () => {
    mockClient = {
      vaults: { list: async () => { throw new Error('429 rate limit exceeded'); } },
    };
    const result = (await tools.healthCheck.handler({}, ctx())) as {
      status: string;
      issues?: Array<{ code: string }>;
    };
    expect(result.status).toBe('degraded');
    expect(result.issues?.[0].code).toBe('RATE_LIMITED');
  });

  it('other API error → DEPENDENCY_UNAVAILABLE', async () => {
    mockClient = {
      vaults: { list: async () => { throw new Error('network down'); } },
    };
    const result = (await tools.healthCheck.handler({}, ctx())) as {
      issues?: Array<{ code: string }>;
    };
    expect(result.issues?.[0].code).toBe('DEPENDENCY_UNAVAILABLE');
  });
});

// =============================================================================
// Read-only surface guarantee
// =============================================================================

describe('read-only surface', () => {
  it('tool sources only call vaults.list / items.list / items.get — never create/put/delete/archive', () => {
    const sources = [
      readFileSync(join(import.meta.dir, '../../src/tools/vaults.ts'), 'utf8'),
      readFileSync(join(import.meta.dir, '../../src/tools/items.ts'), 'utf8'),
      readFileSync(join(import.meta.dir, '../../src/tools/health-check.ts'), 'utf8'),
    ].join('\n');

    // Read-only client calls that ARE allowed
    expect(sources).toContain('client.vaults.list()');
    expect(sources).toContain('client.items.list(');
    expect(sources).toContain('client.items.get(');

    // Mutating SDK calls that must NEVER appear
    for (const forbidden of [
      '.items.create',
      '.items.put',
      '.items.delete',
      '.items.archive',
      '.vaults.create',
      '.vaults.update',
      '.vaults.delete',
    ]) {
      expect(sources.includes(forbidden)).toBe(false);
    }
  });
});
