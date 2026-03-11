import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

export const getFileContent: ToolConfig = {
  description: 'Get the content of a file in a repository',
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
    const data = await githubRequest(context, `/repos/${owner}/${repo}/contents/${path}`, { params: { ref } }) as any;
    if (data.content && data.encoding === 'base64') {
      data.decoded_content = Buffer.from(data.content, 'base64').toString('utf-8');
    }
    return data;
  },
};
