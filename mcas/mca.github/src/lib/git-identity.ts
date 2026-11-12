import { createHash } from 'crypto';
import type { ToolContext } from '@teros/mca-sdk';
import { githubRequest } from './github-client';

export interface GitIdentity {
  name: string;
  email: string;
}

const MAX_CACHED = 200;
const cache = new Map<string, Promise<GitIdentity | null>>();

export function noreplyEmail(login: string, id?: number): string {
  return id ? `${id}+${login}@users.noreply.github.com` : `${login}@users.noreply.github.com`;
}

async function lookup(context: ToolContext, login: string | undefined): Promise<GitIdentity | null> {
  try {
    const user = (await githubRequest(context, '/user')) as { id?: number; login?: string; name?: string | null };
    const userLogin = user?.login || login;
    if (!userLogin) return null;
    return { name: user.name?.trim() || userLogin, email: noreplyEmail(userLogin, user.id) };
  } catch {
    return login ? { name: login, email: noreplyEmail(login) } : null;
  }
}

export async function resolveGitIdentity(context: ToolContext): Promise<GitIdentity | null> {
  let secrets: Record<string, string>;
  try {
    secrets = await context.getUserSecrets();
  } catch {
    return null;
  }
  const token = secrets.USER_ACCESS_TOKEN;
  const login = secrets.USER_LOGIN;
  if (!token) return login ? { name: login, email: noreplyEmail(login) } : null;

  const key = createHash('sha256').update(token).digest('hex');
  let pending = cache.get(key);
  if (!pending) {
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
    pending = lookup(context, login);
    cache.set(key, pending);
    const settled = pending;
    void settled.then((identity) => {
      if (!identity?.email.includes('+') && cache.get(key) === settled) cache.delete(key);
    });
  }
  return pending;
}

export function gitIdentityEnv(identity: GitIdentity): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}
