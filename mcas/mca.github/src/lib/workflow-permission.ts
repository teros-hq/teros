import type { ToolContext } from '@teros/mca-sdk';
import { githubRequest } from './github-client';

export type WorkflowPermissionState = 'granted' | 'pending' | 'unknown';

interface InstallationPayload {
  installations?: Array<{
    account?: { login?: string };
    html_url?: string;
    permissions?: Record<string, string>;
  }>;
}

export function isWorkflowPath(path: string): boolean {
  const normalized = path
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/')
    .toLowerCase();
  return normalized.startsWith('.github/workflows/');
}

export async function workflowPermission(
  context: ToolContext,
  owner: string,
): Promise<{ state: WorkflowPermissionState; url?: string }> {
  let payload: InstallationPayload;
  try {
    payload = (await githubRequest(context, '/user/installations', { params: { per_page: 100 } })) as InstallationPayload;
  } catch {
    return { state: 'unknown' };
  }
  const installation = payload?.installations?.find(
    (i) => i.account?.login?.toLowerCase() === owner.toLowerCase(),
  );
  if (!installation) return { state: 'unknown' };
  return {
    state: installation.permissions?.workflows === 'write' ? 'granted' : 'pending',
    url: installation.html_url,
  };
}

export function workflowPendingAction(owner?: string, url?: string): string {
  const who = owner ?? 'the account or organization that owns the repository';
  const where = url
    ? `at ${url}`
    : `on GitHub: ${owner ? `${owner}'s ` : ''}Settings → Applications (GitHub Apps for an organization) → Installed GitHub Apps → Teros → Review request`;
  return (
    `Tell the user: Teros now asks for the "Workflows" permission so agents can change GitHub Actions files, and an owner of ${who} has to accept it once ${where}. ` +
    'After that, retry the same call; nothing else is needed. Until then the other changes can go through without the .github/workflows/ files. Never reset, rewrite or drop commits to get around this without asking the user.'
  );
}

export function workflowPendingError(owner: string, file: string, url?: string): Error {
  return new Error(
    `[WORKFLOW_PERMISSION_PENDING] \`${file}\` is a GitHub Actions workflow file, and the Teros GitHub App installation on ${owner} has not accepted the "Workflows" permission yet, so GitHub refuses changes to it.\n` +
      `What to do: ${workflowPendingAction(owner, url)}` +
      (url ? `\nLink: ${url}` : ''),
  );
}
