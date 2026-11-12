import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { assertOwnerRepo, githubRequest } from '../lib';

export const MAX_TEXT_CHARS = 150_000;
export const MAX_RAW_FETCH_BYTES = 10 * 1024 * 1024;

interface ContentsPayload {
  name?: string;
  path?: string;
  sha?: string;
  size?: number;
  type?: string;
  encoding?: string;
  content?: string;
  html_url?: string;
  download_url?: string;
}

function isBinary(bytes: Buffer): boolean {
  if (bytes.subarray(0, 8_000).includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}

function megabytes(size: number): string {
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function textResult(meta: Record<string, unknown>, text: string, size: number) {
  if (text.length <= MAX_TEXT_CHARS) return { ...meta, decoded_content: text };
  return {
    ...meta,
    decoded_content: text.slice(0, MAX_TEXT_CHARS),
    truncated: true,
    note: `The file is ${megabytes(size)}; this shows its first ${MAX_TEXT_CHARS.toLocaleString('en-US')} characters. For the rest, clone-repo and read it with git-read-file (it takes line ranges).`,
  };
}

export const getFileContent: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get the content of a file in a repository. Text comes back once, decoded (`decoded_content`), cut at 150,000 characters with `truncated: true` and a note; binary files come back as base64 `content` with `binary: true`; files over 10 MB are refused with the alternative (clone-repo + git-read-file). A directory path returns its entries.',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      path: { type: 'string', description: 'File path in repository' },
      ref: { type: 'string', description: 'Branch, tag, or commit SHA (default: default branch)' },
    },
    required: ['owner', 'repo', 'path'],
  },
  handler: async (args, context) => {
    const { owner, repo, path, ref } = args as { owner: string; repo: string; path: string; ref?: string };
    assertOwnerRepo(owner, repo);
    const safePath = path
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    const url = `/repos/${owner}/${repo}/contents/${safePath}`;
    const data = (await githubRequest(context, url, { params: { ref } })) as ContentsPayload | ContentsPayload[];

    if (Array.isArray(data)) {
      return {
        path,
        type: 'dir',
        entries: data.map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size })),
      };
    }

    const size = data.size ?? 0;
    const meta = {
      name: data.name,
      path: data.path,
      sha: data.sha,
      size,
      type: data.type,
      html_url: data.html_url,
    };

    if (data.encoding === 'base64' && typeof data.content === 'string') {
      const bytes = Buffer.from(data.content, 'base64');
      if (isBinary(bytes)) return { ...meta, encoding: 'base64', content: data.content.replace(/\n/g, ''), binary: true };
      return textResult(meta, bytes.toString('utf-8'), size);
    }

    if (size > MAX_RAW_FETCH_BYTES) {
      throw new Error(
        `[FILE_TOO_LARGE] ${path} is ${megabytes(size)}, too large to read through the GitHub API.\n` +
          'What to do: clone-repo, then read the parts you need with git-read-file (line ranges) or search it with git tools.',
      );
    }

    const raw = (await githubRequest(context, url, { params: { ref }, accept: 'application/vnd.github.raw' })) as string;
    const bytes = Buffer.from(raw, 'utf-8');
    if (raw.includes('\u0000') || raw.includes('�')) {
      return {
        ...meta,
        binary: true,
        note: `Binary file of ${megabytes(size)}; its bytes are not returned. Clone the repo to work with it.`,
      };
    }
    return textResult(meta, raw, size || bytes.length);
  },
};
