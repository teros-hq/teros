import {
  GitHubApiError,
  GitHubInvalidInputError,
  GitHubTimeoutError,
} from '../lib/github-client';
import {
  GitHubAppNotInstalledError,
  GitHubUserNotAuthenticatedError,
} from '../lib/github-user-token';

export type GitHubIssueCode =
  | 'INVALID_INPUT'
  | 'ALREADY_EXISTS'
  | 'WORKFLOW_PERMISSION_PENDING'
  | 'AUTH_REQUIRED'
  | 'AUTH_EXPIRED'
  | 'USER_NOT_AUTHENTICATED'
  | 'APP_NOT_INSTALLED'
  | 'INSUFFICIENT_PERMISSIONS'
  | 'PERMISSION_DENIED'
  | 'RATE_LIMITED'
  | 'SECONDARY_RATE_LIMIT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION'
  | 'UNPROCESSABLE'
  | 'SERVER_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'UNKNOWN';

export interface GitHubIssueAction {
  type: 'user_action' | 'system_action';
  description: string;
  url?: string;
}

export interface ClassifiedGitHubError {
  code: GitHubIssueCode;
  message: string;
  action: GitHubIssueAction;
  status?: number;
  documentationUrl?: string;
  rateLimitReset?: number;
}

export interface ClassifyOptions {
  appSlug?: string;
}

export const RECONNECT_IN_TEROS =
  'Ask the user to reconnect GitHub in Teros: Apps → GitHub → Connect (not Disconnect: that only removes the connection).';

export function appInstallUrl(appSlug?: string): string {
  return `https://github.com/apps/${appSlug || 'teros'}/installations/new`;
}

export function classifyGitHubError(error: unknown, opts: ClassifyOptions = {}): ClassifiedGitHubError {
  if (error instanceof GitHubUserNotAuthenticatedError) {
    return {
      code: 'USER_NOT_AUTHENTICATED',
      message: error.message,
      action: {
        type: 'user_action',
        description:
          'Ask the user to connect GitHub in Teros: Apps → GitHub → Connect. Actions are then signed with their own GitHub account. Retrying before that will not help.',
      },
    };
  }

  if (error instanceof GitHubAppNotInstalledError) {
    return {
      code: 'APP_NOT_INSTALLED',
      message: error.message,
      action: {
        type: 'user_action',
        description:
          'Ask the user to install the Teros GitHub App on the account or organization that owns the repository, with access to it.',
        url: appInstallUrl(opts.appSlug),
      },
    };
  }

  if (error instanceof GitHubTimeoutError) {
    return {
      code: 'TIMEOUT',
      message: error.message,
      action: {
        type: 'user_action',
        description:
          'The GitHub API did not respond in time. Retry the operation, or raise the tool timeout if it keeps timing out.',
      },
      status: error.status,
    };
  }

  if (error instanceof GitHubInvalidInputError) {
    return {
      code: 'VALIDATION',
      message: error.message,
      action: {
        type: 'user_action',
        description:
          'The tool arguments failed validation before reaching GitHub (invalid owner/repo/org/workflow_id or unsafe API path). Fix the identifier and retry.',
      },
      status: error.status,
    };
  }

  if (error instanceof GitHubApiError) {
    return classifyApiError(error, opts);
  }

  if (error instanceof TypeError && /fetch failed|network/i.test(error.message)) {
    return {
      code: 'NETWORK_ERROR',
      message: error.message,
      action: {
        type: 'user_action',
        description: 'Could not reach the GitHub API. Check your network connection and retry.',
      },
    };
  }

  return {
    code: 'UNKNOWN',
    message: error instanceof Error ? error.message : 'Unexpected error talking to GitHub',
    action: {
      type: 'user_action',
      description: 'Retry the operation. If the problem persists, contact support.',
    },
  };
}

function rateLimited(
  error: GitHubApiError,
  reset: number | undefined,
  docUrl: string | undefined,
): ClassifiedGitHubError {
  if (/abuse|secondary rate/i.test(error.message)) {
    return {
      code: 'SECONDARY_RATE_LIMIT',
      message: error.message,
      action: {
        type: 'user_action',
        description:
          'GitHub slowed this account down for making many requests in a short time. Wait at least 60 seconds before the next GitHub call, and make fewer, larger requests (per_page up to 100).',
      },
      status: error.status,
      documentationUrl: docUrl,
    };
  }
  return {
    code: 'RATE_LIMITED',
    message: error.message,
    action: {
      type: 'user_action',
      description: reset
        ? `The GitHub API quota for this account is used up until ${new Date(reset * 1000).toISOString()}. Tell the user and continue after that time; local git tools still work.`
        : 'The GitHub API quota for this account is used up. Wait a few minutes and retry; local git tools still work.',
    },
    status: error.status,
    documentationUrl: docUrl,
    rateLimitReset: reset,
  };
}

function classifyApiError(error: GitHubApiError, opts: ClassifyOptions): ClassifiedGitHubError {
  const installUrl = appInstallUrl(opts.appSlug);
  const literal = error.message;
  const lower = literal.toLowerCase();
  const reset = error.rateLimitReset ?? undefined;
  const docUrl = error.documentationUrl ?? undefined;
  const errors = (typeof error.body === 'object' && error.body?.errors) || [];

  switch (error.status) {
    case 401:
      return {
        code: 'AUTH_EXPIRED',
        message: literal,
        action: {
          type: 'user_action',
          description: `GitHub no longer accepts this user's connection (expired or revoked). ${RECONNECT_IN_TEROS}`,
        },
        status: error.status,
        documentationUrl: docUrl,
      };

    case 403: {
      // App-specific: installation suspended or permission missing
      if (/suspended|installation.*not.*authorized/i.test(lower)) {
        return {
          code: 'APP_NOT_INSTALLED',
          message: literal,
          action: {
            type: 'user_action',
            description:
              'The Teros GitHub App installation on this account or organization was suspended or removed. Ask the user (or an owner of the organization) to install it again.',
            url: installUrl,
          },
          status: error.status,
          documentationUrl: docUrl,
        };
      }
      if (/resource not accessible by integration|missing.*permission/i.test(lower)) {
        return {
          code: 'INSUFFICIENT_PERMISSIONS',
          message: literal,
          action: {
            type: 'user_action',
            description:
              'The Teros GitHub App installation is missing a permission this action needs. Ask an owner of the account or organization to open the installation on GitHub (Settings → Applications → Installed GitHub Apps → Teros) and accept any pending permission request.',
          },
          status: error.status,
          documentationUrl: docUrl,
        };
      }
      if (error.rateLimitRemaining === 0 || /rate limit|api rate|abuse/i.test(lower)) {
        return rateLimited(error, reset, docUrl);
      }
      return {
        code: 'PERMISSION_DENIED',
        message: literal,
        action: {
          type: 'user_action',
          description: /sso|saml/i.test(lower)
            ? 'The organization requires single sign-on. Ask the user to authorize the Teros App for that organization on GitHub (SAML SSO), then retry.'
            : /scope|oauth/i.test(lower)
              ? `The user's GitHub connection lacks a permission this action needs. ${RECONNECT_IN_TEROS}`
              : 'The connected GitHub user cannot do this here: they need the right access to the repository, and the Teros GitHub App must be installed with access to it. Ask the user to check both. Retrying will not help.',
        },
        status: error.status,
        documentationUrl: docUrl,
      };
    }

    case 404:
      return {
        code: 'NOT_FOUND',
        message: literal,
        action: {
          type: 'user_action',
          description:
            'Not found, or not visible to this connection: check the owner, repository, number or path. A private repository also answers "Not Found" when the Teros GitHub App is not installed on its owner or has no access to it; then ask the user to add it to the installation.',
        },
        status: error.status,
        documentationUrl: docUrl,
      };

    case 409:
      return {
        code: 'CONFLICT',
        message: literal,
        action: {
          type: 'user_action',
          description: 'GitHub reports a conflict with the current state (merge conflict, branch out of sync, etc.).',
        },
        status: error.status,
        documentationUrl: docUrl,
      };

    case 429:
      return rateLimited(error, reset, docUrl);

    case 422: {
      if (/already exists/i.test(lower) || errors.some((e) => e.code === 'already_exists')) {
        return {
          code: 'ALREADY_EXISTS',
          message: literal,
          action: {
            type: 'user_action',
            description:
              'It already exists on GitHub. Use the existing one (get it first to check it is what you need), or pick another name.',
          },
          status: error.status,
          documentationUrl: docUrl,
        };
      }
      const detail = errors
        .map((e) => `${e.resource ?? '?'}.${e.field ?? '?'}: ${e.code ?? e.message ?? 'invalid'}`)
        .join('; ');
      return {
        code: 'VALIDATION',
        message: literal,
        action: {
          type: 'user_action',
          description: detail
            ? `Validation failed: ${detail}.`
            : 'GitHub rejected the input. Review the request body and retry.',
        },
        status: error.status,
        documentationUrl: docUrl,
      };
    }

    default:
      if (error.status >= 500) {
        return {
          code: 'SERVER_ERROR',
          message: literal,
          action: {
            type: 'user_action',
            description: 'GitHub returned a server error. Check status.github.com and retry.',
            url: 'https://www.githubstatus.com/',
          },
          status: error.status,
          documentationUrl: docUrl,
        };
      }
      if (/not connected|not authorized/i.test(lower)) {
        return {
          code: 'AUTH_REQUIRED',
          message: literal,
          action: {
            type: 'user_action',
            description: RECONNECT_IN_TEROS,
          },
          status: error.status,
          documentationUrl: docUrl,
        };
      }
      return {
        code: 'UNKNOWN',
        message: literal,
        action: {
          type: 'user_action',
          description: 'Unexpected GitHub response. Retry once; if it fails again, tell the user what GitHub answered.',
        },
        status: error.status,
        documentationUrl: docUrl,
      };
  }
}

export function formatClassifiedGitHubError(classified: ClassifiedGitHubError): string {
  const lines = [`[${classified.code}] ${classified.message}`, `What to do: ${classified.action.description}`];
  if (classified.action.url) lines.push(`Link: ${classified.action.url}`);
  return lines.join('\n');
}
