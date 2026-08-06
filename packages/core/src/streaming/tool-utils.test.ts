/**
 * tool-utils tests (TER-469).
 *
 * Red de determineToolKind, extractLocations y formatToolDisplay —
 * 0 tests previos.
 */

import { describe, expect, it } from 'bun:test';
import { determineToolKind, extractLocations, formatToolDisplay } from './tool-utils';

describe('determineToolKind', () => {
  it('classifies the read set', () => {
    for (const name of ['read', 'glob', 'grep', 'list', 'webfetch', 'todoread']) {
      expect(determineToolKind(name)).toBe('read');
    }
  });

  it('classifies the edit set', () => {
    for (const name of ['edit', 'write', 'bash', 'todowrite']) {
      expect(determineToolKind(name)).toBe('edit');
    }
  });

  it('is case-insensitive', () => {
    expect(determineToolKind('READ')).toBe('read');
    expect(determineToolKind('Bash')).toBe('edit');
  });

  it('unknown and MCP tools default to other', () => {
    expect(determineToolKind('mca.linear.create-issue')).toBe('other');
    expect(determineToolKind('')).toBe('other');
  });
});

describe('extractLocations', () => {
  it('file tools use filePath', () => {
    expect(extractLocations('read', { filePath: '/a/b.ts' })).toEqual([{ path: '/a/b.ts' }]);
    expect(extractLocations('edit', { filePath: '/a/b.ts' })).toEqual([{ path: '/a/b.ts' }]);
    expect(extractLocations('write', { filePath: '/a/b.ts' })).toEqual([{ path: '/a/b.ts' }]);
  });

  it('search/list tools use path', () => {
    expect(extractLocations('glob', { pattern: '*.ts', path: '/src' })).toEqual([{ path: '/src' }]);
    expect(extractLocations('grep', { path: '/src' })).toEqual([{ path: '/src' }]);
    expect(extractLocations('list', { path: '/src' })).toEqual([{ path: '/src' }]);
  });

  it('file tools without their expected field return []', () => {
    expect(extractLocations('read', { path: '/ignored' })).toEqual([]);
    expect(extractLocations('glob', { filePath: '/ignored' })).toEqual([]);
  });

  it('bash never extracts locations', () => {
    expect(extractLocations('bash', { command: 'cat /etc/hosts' })).toEqual([]);
  });

  it('unknown tools probe path → filePath → file → directory in that exact order', () => {
    expect(extractLocations('mca-tool', { path: '/p', filePath: '/f' })).toEqual([{ path: '/p' }]);
    expect(extractLocations('mca-tool', { filePath: '/f', file: '/x' })).toEqual([{ path: '/f' }]);
    expect(extractLocations('mca-tool', { file: '/x', directory: '/d' })).toEqual([{ path: '/x' }]);
    expect(extractLocations('mca-tool', { directory: '/d' })).toEqual([{ path: '/d' }]);
    expect(extractLocations('mca-tool', { other: 1 })).toEqual([]);
  });

  it('non-string path-like values are ignored for unknown tools', () => {
    expect(extractLocations('mca-tool', { path: 42, filePath: ['x'] })).toEqual([]);
  });

  it('null/non-object input returns []', () => {
    expect(extractLocations('read', null as any)).toEqual([]);
    expect(extractLocations('read', 'str' as any)).toEqual([]);
  });
});

describe('formatToolDisplay', () => {
  it('escapes HTML entities in the tool name', () => {
    const out = formatToolDisplay('<b>&tool', 'other', []);
    expect(out).toBe('&lt;b&gt;&amp;tool');
  });

  it('file tools: first line shows "filePath: <path>" with leading ../ stripped', () => {
    const out = formatToolDisplay('read', 'read', [{ path: '../../src/index.ts' }]);
    expect(out).toBe('read · filePath: src/index.ts');
  });

  it('appends pretty-printed input JSON after a blank line', () => {
    const input = { filePath: '/a.ts' };
    const out = formatToolDisplay('read', 'read', [{ path: '/a.ts' }], input);
    expect(out).toBe(`read · filePath: /a.ts\n\n${JSON.stringify(input, null, 2)}`);
  });

  it('appends output after input; error takes precedence over output', () => {
    const input = { a: 1 };
    const withOutput = formatToolDisplay('t', 'other', [], input, '{"ok":true}');
    expect(withOutput).toBe(`t · a: 1\n\n${JSON.stringify(input, null, 2)}\n\n{"ok":true}`);

    const withError = formatToolDisplay('t', 'other', [], input, '{"ok":true}', '{"err":"boom"}');
    expect(withError).toBe(`t · a: 1\n\n${JSON.stringify(input, null, 2)}\n\n{"err":"boom"}`);
  });

  it('a value of EXACTLY 50 chars is NOT truncated (> boundary)', () => {
    const exact = 'w'.repeat(50);
    const out = formatToolDisplay('t', 'other', [], { a: exact });
    expect(out.split('\n')[0]).toBe(`t · a: ${exact}`);
  });

  it('params summary takes the first 3 non-null entries, truncating values at 50 chars', () => {
    const long = 'v'.repeat(60);
    const out = formatToolDisplay('t', 'other', [], {
      skip: undefined,
      alsoSkip: null,
      a: long,
      b: { nested: true },
      c: 3,
      d: 'never-shown',
    });
    const firstLine = out.split('\n')[0];
    expect(firstLine).toBe(`t · a: ${'v'.repeat(50)}..., b: {"nested":true}, c: 3`);
  });

  it('empty input object → name only, no params, no JSON block', () => {
    expect(formatToolDisplay('t', 'other', [], {})).toBe('t');
  });

  describe('shell_exec special handling', () => {
    it('prefers output.description when output is valid JSON', () => {
      const out = formatToolDisplay(
        'shell_exec',
        'other',
        [],
        { description: 'from input' },
        '{"description":"from output","exit":0}',
      );
      expect(out.split('\n')[0]).toBe('shell_exec · from output');
    });

    it('falls back to input.description when output is not JSON', () => {
      const out = formatToolDisplay(
        'shell_exec',
        'other',
        [],
        { description: 'list files' },
        'plain text output',
      );
      expect(out.split('\n')[0]).toBe('shell_exec · list files');
    });

    it('"exec" alias gets the same treatment; no description → bare name', () => {
      const out = formatToolDisplay('exec', 'other', [], { command: 'ls' });
      expect(out.split('\n')[0]).toBe('exec');
    });
  });
});
