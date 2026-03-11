import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

export const createOrUpdateFile: ToolConfig = {
  description: 'Create or update a file in a repository',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      path: { type: 'string', description: 'File path in repository' },
      message: { type: 'string', description: 'Commit message' },
      content: { type: 'string', description: 'File content (will be base64 encoded)' },
      branch: { type: 'string', description: 'Branch name (default: default branch)' },
      sha: { type: 'string', description: 'SHA of file being replaced (required for updates)' },
    },
    required: ['owner', 'repo', 'path', 'message', 'content'],
  },
  handler: async (args, context) => {
    const { owner, repo, path, message, content, branch, sha } = args as {
      owner: string; repo: string; path: string; message: string; content: string; branch?: string; sha?: string;
    };
    const body: Record<string, unknown> = {
      message,
      content: Buffer.from(content).toString('base64'),
    };
    if (branch) body.branch = branch;
    if (sha) body.sha = sha;
    return await githubRequest(context, `/repos/${owner}/${repo}/contents/${path}`, { method: 'PUT', body });
  },
};
