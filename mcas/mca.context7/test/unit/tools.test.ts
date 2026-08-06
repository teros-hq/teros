import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resolveLibrary } from '../../src/tools/resolve-library';
import { getDocs } from '../../src/tools/get-docs';

const originalFetch = globalThis.fetch;

function makeContext(userSecrets: Record<string, string> = {}) {
  return {
    execution: { userId: 'u1', appId: 'a1' },
    backend: null,
    requestId: 'req_test',
    getSystemSecrets: async () => ({}),
    getUserSecrets: async () => userSecrets,
    updateUserSecrets: async () => {},
    getScope: () => 'u1',
    getData: async () => ({ value: null, exists: false }),
    setData: async () => ({ success: true }),
    deleteData: async () => ({ success: true, deleted: false }),
    listData: async () => ({ keys: [] }),
  } as Parameters<typeof resolveLibrary.handler>[1];
}

describe('resolve-library tool', () => {
  beforeEach(() => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: [
            { id: '/foo/bar', title: 'Foo', description: '', snippetsCount: 100, reputation: 'High', benchmarkScore: 80 },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('returns structuredContent + content', async () => {
    const result = (await resolveLibrary.handler({ libraryName: 'foo' }, makeContext())) as {
      content: { type: string; text: string }[];
      structuredContent: { candidates: unknown[]; cached: boolean; resolvedFrom: string };
    };
    expect(result.content[0].type).toBe('text');
    expect(result.structuredContent.candidates).toHaveLength(1);
    expect(result.structuredContent.cached).toBe(false);
    expect(result.structuredContent.resolvedFrom).toBe('anonymous');
  });

  test('reports resolvedFrom user when CONTEXT7_API_KEY set', async () => {
    const result = (await resolveLibrary.handler(
      { libraryName: 'foo' },
      makeContext({ CONTEXT7_API_KEY: 'ctx7sk-x' }),
    )) as { structuredContent: { resolvedFrom: string } };
    expect(result.structuredContent.resolvedFrom).toBe('user');
  });

  test('rejects empty libraryName', async () => {
    await expect(resolveLibrary.handler({ libraryName: '' }, makeContext())).rejects.toThrow(/required/);
  });
});

describe('get-docs tool', () => {
  beforeEach(() => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          codeSnippets: [
            {
              codeTitle: 'useEffect',
              codeId: 'src://useEffect.md',
              codeDescription: 'desc',
              codeLanguage: 'ts',
              codeList: [{ language: 'ts', code: 'useEffect(() => {}, []);' }],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('returns structured snippets array', async () => {
    const result = (await getDocs.handler({ libraryId: '/x/y', query: 'useEffect' }, makeContext())) as {
      structuredContent: { snippets: { code?: string; language?: string }[]; totalReturned: number };
    };
    expect(result.structuredContent.snippets).toHaveLength(1);
    expect(result.structuredContent.snippets[0].code).toContain('useEffect');
    expect(result.structuredContent.snippets[0].language).toBe('ts');
    expect(result.structuredContent.totalReturned).toBe(1);
  });

  test('honors limit', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          codeSnippets: Array.from({ length: 5 }, (_v, i) => ({
            codeTitle: `t${i}`,
            codeId: `s${i}`,
            codeDescription: `d${i}`,
            codeList: [{ language: 'ts', code: `c${i}` }],
          })),
        }),
        { status: 200 },
      )) as typeof fetch;
    const result = (await getDocs.handler(
      { libraryId: '/x/y', query: 'foo', limit: 2 },
      makeContext(),
    )) as { structuredContent: { totalReturned: number } };
    expect(result.structuredContent.totalReturned).toBe(2);
  });

  test('rejects empty libraryId or query', async () => {
    await expect(getDocs.handler({ libraryId: '', query: 'q' }, makeContext())).rejects.toThrow(/libraryId/);
    await expect(getDocs.handler({ libraryId: '/x', query: '' }, makeContext())).rejects.toThrow(/query/);
  });
});
