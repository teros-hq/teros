import { HealthCheckBuilder, type ToolConfig } from '@teros/mca-sdk';
import { accountApiRaw, DEFAULT_REGION, MAKE_REGIONS, type MakeRegion } from '../lib/make-client';
import { getUserSecretsSafe } from './_helpers';

const VERSION = '2.0.0';

/**
 * -health-check — SDK contract tool.
 *
 * The webhook trigger needs no credentials, so an MCA with no token configured
 * is still fully usable → we report `ready` with no blocking issue (never mark
 * unhealthy just because the optional account token is absent). When a
 * MAKE_API_TOKEN IS configured we validate it against `GET /api/v2/users/me`
 * for the resolved region.
 *
 * Recommended scopes for full v2.0 functionality:
 *   - scenarios:read
 *   - scenarios:write
 *   - teams:read
 *   - organizations:read
 */
export const healthCheck: ToolConfig = {
  description:
    'Internal health check. The webhook trigger needs no credentials; if a MAKE_API_TOKEN is configured, validates it against the Make account API. For full scenario management, the token should have scopes: scenarios:read, scenarios:write, teams:read, organizations:read.',
  parameters: { type: 'object', properties: {} },
  annotations: {
    version: VERSION,
    stability: 'stable',
    readOnlyHint: true,
    openWorldHint: true,
  },
  handler: async (_args, context) => {
    const secrets = await getUserSecretsSafe(context);
    const builder = new HealthCheckBuilder({ user: secrets })
      .setVersion(VERSION)
      .setUptime(Math.floor(process.uptime()));

    const token = secrets.MAKE_API_TOKEN ?? secrets.make_api_token;

    // No token → webhook-only mode is fully functional. Healthy, no issue.
    if (!token || token.trim().length === 0) {
      return builder.build();
    }

    // Token present → validate region config first.
    const rawRegion = (secrets.MAKE_REGION ?? '').trim().toLowerCase();
    if (rawRegion.length > 0 && !(MAKE_REGIONS as readonly string[]).includes(rawRegion)) {
      builder.addIssue(
        'CONFIG_INVALID',
        `Invalid MAKE_REGION "${secrets.MAKE_REGION}" (expected ${MAKE_REGIONS.join(', ')})`,
        {
          type: 'user_action',
          description: `Set MAKE_REGION to one of: ${MAKE_REGIONS.join(', ')}`,
        },
      );
      return builder.build();
    }
    const region: MakeRegion = (rawRegion as MakeRegion) || DEFAULT_REGION;

    try {
      // accountApiRaw bounds this probe with timeoutMs (5s) so a hung socket
      // can't stall the health check up to the global ~120s socket timeout.
      const { status } = await accountApiRaw('GET', '/users/me', {
        apiKey: token.trim(),
        region,
        timeoutMs: 5000,
      });

      if (status === 401) {
        // 401 = no valid auth → the token is wrong/expired.
        builder.addIssue('AUTH_INVALID', 'Make API token is invalid or expired', {
          type: 'user_action',
          description:
            'Replace MAKE_API_TOKEN in user secrets with a valid token from your Make profile (API/Tokens tab)',
        });
      } else if (status === 429) {
        builder.addIssue('RATE_LIMITED', 'Make API rate limit reached', {
          type: 'auto_retry',
          description: 'Make limits API calls (~60/min on free plans); retry shortly',
        });
      } else if (status >= 400 && status !== 403) {
        // 403 is treated as healthy on purpose: the token authenticated fine but
        // lacks the `organization:read` scope that /users/me needs. A token scoped
        // only to `scenarios:*` is fully usable by this MCA's tools, so a 403 here
        // must NOT surface a false AUTH_INVALID. Any other 4xx/5xx is a real
        // dependency problem.
        builder.addIssue('DEPENDENCY_UNAVAILABLE', `Make API returned ${status}`, {
          type: 'auto_retry',
          description: 'Make API temporarily unavailable',
        });
      }
    } catch (err) {
      builder.addIssue(
        'DEPENDENCY_UNAVAILABLE',
        `Failed to reach Make API: ${err instanceof Error ? err.message : 'network error'}`,
        {
          type: 'auto_retry',
          description: 'Network error connecting to Make API',
        },
      );
    }

    return builder.build();
  },
};
