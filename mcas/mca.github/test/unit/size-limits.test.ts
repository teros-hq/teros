import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { oversizedBlobs } from '../../src/lib/git-local';
import { classifyGitError } from '../../src/tools/_git-error';
import { REST_TOOLS } from '../../src/tools/rest-tools';

describe('push size limits are explicit ("muy pesada")', () => {
  it("GitHub's 100 MB refusal names the file and the way out", () => {
    const c = classifyGitError({
      code: 1,
      stdout: '',
      stderr:
        "remote: error: Trace: 1234\nremote: error: See https://gh.io/lfs for more information.\nremote: error: File assets/video.mp4 is 151.20 MB; this exceeds GitHub's file size limit of 100.00 MB\nremote: error: GH001: Large files detected. You may want to try Git Large File Storage - https://git-lfs.github.com.\n ! [remote rejected] main -> main (pre-receive hook declined)",
      command: 'push',
    });
    expect(c.code).toBe('GIT_FILE_TOO_LARGE');
    expect(c.message).toContain('assets/video.mp4');
    expect(c.action.description).toContain('100 MB');
  });

  it.each([
    'remote: fatal: pack exceeds maximum allowed size (2.00 GiB)',
    'error: RPC failed; HTTP 413 curl 22 The requested URL returned error: 413\nsend-pack: unexpected disconnect while reading sideband packet',
  ])('a push too big as a whole is GIT_PUSH_TOO_LARGE (%#)', (stderr) => {
    expect(classifyGitError({ code: 1, stdout: '', stderr, command: 'push' }).code).toBe('GIT_PUSH_TOO_LARGE');
  });

  describe('oversizedBlobs: checked before pushing', () => {
    let root: string;
    let clone: string;
    const env = { ...process.env };

    const git = (args: string[]) => execFileSync('git', ['-C', clone, ...args], { encoding: 'utf-8', env: process.env }).trim();

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'mca-size-'));
      process.env.GIT_CONFIG_GLOBAL = '/dev/null';
      process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'T';
      process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 't@example.com';
      const bare = join(root, 'remote.git');
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
      clone = join(root, 'clone');
      execFileSync('git', ['clone', '-q', bare, clone], { env: process.env });
      writeFileSync(join(clone, 'small.txt'), 'x\n');
      git(['add', '.']);
      git(['commit', '-qm', 'init']);
      git(['push', '-q', 'origin', 'main']);
    });

    afterEach(() => {
      for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
      Object.assign(process.env, env);
      rmSync(root, { recursive: true, force: true });
    });

    it('finds files over the limit in commits not yet on the remote', async () => {
      writeFileSync(join(clone, 'big.bin'), Buffer.alloc(4096, 1));
      writeFileSync(join(clone, 'ok.txt'), 'fine\n');
      git(['add', '.']);
      git(['commit', '-qm', 'big']);
      expect(await oversizedBlobs(clone, 'origin', 'main', 2048)).toEqual([{ path: 'big.bin', size: 4096 }]);
    });

    it('ignores what the remote already has', async () => {
      expect(await oversizedBlobs(clone, 'origin', 'main', 1)).toEqual([]);
    });
  });
});

describe('bodies over GitHub limits are refused before sending', () => {
  const ctx = {
    getUserSecrets: async () => ({ USER_ACCESS_TOKEN: 'ghu_size_limits_token_123456' }),
    getSystemSecrets: async () => ({}),
  } as never;
  const realFetch = globalThis.fetch;
  let fetched = 0;

  beforeEach(() => {
    fetched = 0;
    globalThis.fetch = (async () => {
      fetched++;
      return new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it.each([
    ['create-pull', { owner: 'acme', repo: 'api', title: 't', head: 'feat', base: 'main' }],
    ['create-issue', { owner: 'acme', repo: 'api', title: 't' }],
    ['add-issue-comment', { owner: 'acme', repo: 'api', issue_number: 1 }],
  ])('%s with a 70,000-character body', async (name, args) => {
    let message = '';
    try {
      await REST_TOOLS[name as string].handler({ ...(args as object), body: 'x'.repeat(70_000) }, ctx);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message.startsWith('[BODY_TOO_LONG]')).toBe(true);
    expect(message).toContain('65,536');
    expect(fetched).toBe(0);
  });
});
