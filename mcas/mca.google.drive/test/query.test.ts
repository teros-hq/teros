/**
 * Query building + escaping for list-files / search-files (TER-514 smoke finding).
 *
 * Bug surfaced by the smoke: `list-files` interpolated agent-provided values raw into
 * the Drive `q` string, so a value containing a single quote broke the query
 * (`name contains 'not 'me' in owners'` → `Error: Invalid Value`). Two fixes:
 *   - escape single quotes / backslashes in literal values (escapeQueryValue)
 *   - add a `driveQuery` param for raw Drive-syntax clauses (what the agent wanted)
 */

import { describe, expect, it, mock } from 'bun:test';
import { buildListQuery, escapeQueryValue } from '../src/tools/_query';

describe('escapeQueryValue', () => {
  it("escapes single quotes as \\'", () => {
    expect(escapeQueryValue("O'Brien")).toBe("O\\'Brien");
  });

  it('escapes backslashes first, then quotes', () => {
    expect(escapeQueryValue("a\\b'c")).toBe("a\\\\b\\'c");
  });

  it('leaves quote-free values untouched', () => {
    expect(escapeQueryValue('budget report.pdf')).toBe('budget report.pdf');
  });

  // Property (model-based / inverse): for ANY input, escaping is lossless — a
  // reference un-escaper (a backslash consumes the next char literally, which is
  // exactly Drive's quoting rule) must recover the original. This catches a wrong
  // escape order (quote-first doubles the backslash and breaks the round-trip).
  it('round-trips losslessly over generated adversarial inputs', () => {
    const unescape = (s: string): string => {
      let out = '';
      for (let i = 0; i < s.length; i++) {
        if (s[i] === '\\' && i + 1 < s.length) {
          out += s[i + 1];
          i++;
        } else {
          out += s[i];
        }
      }
      return out;
    };
    const frags = ['a', "'", '\\', "''", '\\\\', "\\'", ' ', 'ñ', 'x\ty', '日'];
    const inputs: string[] = [];
    for (const a of frags) for (const b of frags) for (const c of frags) inputs.push(a + b + c);
    expect(inputs.length).toBeGreaterThan(500);
    for (const s of inputs) {
      expect(unescape(escapeQueryValue(s))).toBe(s);
    }
  });
});

describe('buildListQuery (pure)', () => {
  it('defaults to non-trashed files', () => {
    expect(buildListQuery({})).toBe('trashed=false');
  });

  it('skips empty-string clauses (no dangling operators)', () => {
    expect(buildListQuery({ folderId: '', query: '', mimeType: '' })).toBe('trashed=false');
  });

  it("regression: query with single quotes is escaped, not broken (the Invalid Value bug)", () => {
    expect(buildListQuery({ query: "not 'me' in owners" })).toBe(
      "trashed=false and name contains 'not \\'me\\' in owners'",
    );
  });

  it('escapes folderId and mimeType too', () => {
    expect(buildListQuery({ folderId: "fol'der", mimeType: "ty'pe" })).toBe(
      "trashed=false and 'fol\\'der' in parents and mimeType='ty\\'pe'",
    );
  });

  it('appends driveQuery raw (NOT escaped) and parenthesised', () => {
    expect(buildListQuery({ driveQuery: "not 'me' in owners" })).toBe(
      "trashed=false and (not 'me' in owners)",
    );
  });

  it('combines all clauses in order', () => {
    expect(
      buildListQuery({ folderId: 'F', query: 'budget', mimeType: 'application/pdf', driveQuery: "starred = true" }),
    ).toBe(
      "trashed=false and 'F' in parents and name contains 'budget' and mimeType='application/pdf' and (starred = true)",
    );
  });
});

// Faithful boundary mock: capture the exact `q` string that reaches files.list.
function makeDrive() {
  const calls: Record<string, any> = {};
  const drive = {
    files: {
      list: mock(async (params: any) => {
        calls.list = params;
        return { data: { files: [] } };
      }),
    },
  };
  return { drive, calls };
}

// mock.module is process-global in bun, so this must export the FULL barrel surface
// any tool imports — otherwise it clobbers the mock installed by shared-drive.test.ts.
function installLibMock(drive: any) {
  mock.module('../src/lib', () => ({
    initializeGoogleClients: async () => ({ drive }),
    ensureAuthenticated: async () => {},
    withAuthRetry: async (_ctx: any, op: () => Promise<any>) => op(),
    saveToDownloads: async () => '/tmp/x',
    ALL_DRIVES: { supportsAllDrives: true },
    ALL_DRIVES_LIST: {
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      corpora: 'allDrives',
    },
  }));
}

const ctx = {} as any;

describe('list-files handler', () => {
  it('passes the built (escaped) query through to files.list', async () => {
    const { drive, calls } = makeDrive();
    installLibMock(drive);
    const { listFiles } = await import('../src/tools/list-files');
    await listFiles.handler({ query: "not 'me' in owners" }, ctx);
    expect(calls.list.q).toBe("trashed=false and name contains 'not \\'me\\' in owners'");
  });

  it('rejects an empty driveQuery at the boundary', async () => {
    const { drive } = makeDrive();
    installLibMock(drive);
    const { listFiles } = await import('../src/tools/list-files');
    await expect(listFiles.handler({ driveQuery: '   ' }, ctx)).rejects.toThrow(/driveQuery/);
  });
});

describe('search-files query building', () => {
  it('escapes the search term', async () => {
    const { drive, calls } = makeDrive();
    installLibMock(drive);
    const { searchFiles } = await import('../src/tools/search-files');
    await searchFiles.handler({ searchTerm: "O'Brien" }, ctx);
    expect(calls.list.q).toBe("name contains 'O\\'Brien' and trashed = false");
  });
});
