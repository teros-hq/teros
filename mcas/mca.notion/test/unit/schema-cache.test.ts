/**
 * Schema cache — TTL hit/miss + drift retry.
 */

import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
  getSchema,
  invalidateSchema,
  withSchemaCache,
} from '../../src/tools/_schema-cache';

afterEach(() => {
  invalidateSchema();
});

function buildClient(schemaProperties: Record<string, { type: string }>) {
  return {
    databases: {
      retrieve: mock(async () => ({
        object: 'database',
        id: 'db-a',
        data_sources: [{ id: 'ds-a' }],
      })),
    },
    dataSources: {
      retrieve: mock(async () => ({
        object: 'data_source',
        id: 'ds-a',
        properties: schemaProperties,
      })),
    },
  };
}

describe('getSchema', () => {
  it('hits the cache on the second call', async () => {
    const client = buildClient({ Status: { type: 'status' } }) as any;

    await getSchema(client, 'db-a');
    await getSchema(client, 'db-a');

    expect(client.databases.retrieve).toHaveBeenCalledTimes(1);
    expect(client.dataSources.retrieve).toHaveBeenCalledTimes(1);
  });

  it('refetches after invalidate', async () => {
    const client = buildClient({ Status: { type: 'status' } }) as any;

    await getSchema(client, 'db-a');
    invalidateSchema('db-a');
    await getSchema(client, 'db-a');

    expect(client.dataSources.retrieve).toHaveBeenCalledTimes(2);
  });
});

describe('withSchemaCache', () => {
  it('runs the action with the resolved schema', async () => {
    const client = buildClient({ Status: { type: 'status' } }) as any;
    const captured: any[] = [];
    await withSchemaCache(client, 'db-a', async (schema) => {
      captured.push(schema);
      return null;
    });
    expect(captured[0]).toEqual({ Status: { type: 'status', name: 'Status' } });
  });

  it('evicts and retries once on validation_error', async () => {
    const client = buildClient({ Status: { type: 'status' } }) as any;

    let attempt = 0;
    const result = await withSchemaCache(client, 'db-a', async (schema) => {
      attempt += 1;
      if (attempt === 1) {
        const err: any = new Error('validation failed');
        err.code = 'validation_error';
        throw err;
      }
      return schema;
    });

    expect(attempt).toBe(2);
    expect(result).toEqual({ Status: { type: 'status', name: 'Status' } });
    // Second fetch happened due to invalidate.
    expect(client.dataSources.retrieve).toHaveBeenCalledTimes(2);
  });

  it('does not retry on non-validation errors', async () => {
    const client = buildClient({ Status: { type: 'status' } }) as any;

    let attempt = 0;
    await expect(
      withSchemaCache(client, 'db-a', async () => {
        attempt += 1;
        const err: any = new Error('not found');
        err.code = 'object_not_found';
        throw err;
      }),
    ).rejects.toThrow();

    expect(attempt).toBe(1);
  });
});
