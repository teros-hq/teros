import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { githubRequest } from '../lib';

interface AuthenticatedUserPayload {
  login: string;
  name?: string | null;
  html_url?: string;
  type?: 'User' | 'Organization' | 'Bot';
}

/**
 * Returns the **real identity of the authenticated token** via `GET /user`.
 *
 * This is the authoritative answer to "who am I on GitHub?". It must NOT be
 * confused with `get-installation-context`, which lists the App installations
 * *reachable* by the user (their own account + orgs/collabs they belong to) —
 * that list can contain other accounts' logins and has caused agents to
 * misreport the user's identity (see task 2026-10-01, security-ux audit).
 *
 * History: `get-user` was previously a deprecated alias of
 * `get-installation-context` returning `GET /user/installations`. Agents read
 * `installations[0].account.login` as "your account" and produced false
 * "crossed token" security reports. The alias has been replaced by this real
 * identity lookup.
 */
export const getUser: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get the authenticated GitHub user of the current token (real identity: login, name, profile URL, account type). Use this — not get-installation-context — to answer "who am I / which account is connected?".',
  parameters: { type: 'object', properties: {} },
  handler: async (_args, context) => {
    const payload = (await githubRequest(context, '/user')) as AuthenticatedUserPayload;

    if (!payload || typeof payload.login !== 'string' || payload.login.length === 0) {
      throw new Error(
        'GET /user returned no login — the token identity could not be resolved. The account may need to be reconnected.',
      );
    }

    return {
      login: payload.login,
      name: payload.name ?? null,
      html_url: payload.html_url ?? null,
      type: payload.type ?? 'User',
    };
  },
};
