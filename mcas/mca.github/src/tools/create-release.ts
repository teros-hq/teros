import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

export const createRelease: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Create a GitHub release tagged at `tag_name`. If `target_commitish` omitted GitHub uses the default branch. Returns {id, tag_name, name, html_url, draft, prerelease, published_at}.',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      tag_name: { type: 'string', description: 'Tag this release points to (created if missing)' },
      target_commitish: {
        type: 'string',
        description: 'Branch or SHA the tag is created from (default: repository default branch)',
      },
      name: { type: 'string', description: 'Release title (default: tag_name)' },
      body: { type: 'string', description: 'Release notes (markdown)' },
      draft: { type: 'boolean', description: 'Create as draft (default: false)' },
      prerelease: { type: 'boolean', description: 'Mark as prerelease (default: false)' },
      generate_release_notes: {
        type: 'boolean',
        description: 'Auto-generate release notes from commits (default: false)',
      },
    },
    required: ['owner', 'repo', 'tag_name'],
  },
  handler: async (args, context) => {
    const {
      owner,
      repo,
      tag_name,
      target_commitish,
      name,
      body,
      draft,
      prerelease,
      generate_release_notes,
    } = args as {
      owner: string;
      repo: string;
      tag_name: string;
      target_commitish?: string;
      name?: string;
      body?: string;
      draft?: boolean;
      prerelease?: boolean;
      generate_release_notes?: boolean;
    };
    if (!tag_name || tag_name.trim() === '') {
      throw new Error('`tag_name` must be a non-empty string.');
    }
    if (target_commitish !== undefined && target_commitish.trim() === '') {
      throw new Error('`target_commitish` must be non-empty when provided.');
    }
    return await githubRequest(context, `/repos/${owner}/${repo}/releases`, {
      method: 'POST',
      body: {
        tag_name,
        target_commitish,
        name,
        body,
        draft: draft ?? false,
        prerelease: prerelease ?? false,
        generate_release_notes: generate_release_notes ?? false,
      },
    });
  },
};
