import type { ToolContext } from '@teros/mca-sdk';
import { HunterError } from '../lib/errors';

/**
 * Resolve the user's Hunter API key from user secrets (lazy — fetched per call,
 * never cached at module scope). Tolerates lower/upper case key names.
 * Throws a typed AUTH_INVALID error when missing so the LLM/AuthPanel can react.
 */
export async function getApiKey(context: ToolContext): Promise<string> {
  let userSecrets: Record<string, string> | null;
  try {
    userSecrets = await context.getUserSecrets();
  } catch (err) {
    // A transient failure of the secrets backend is NOT "no key configured" —
    // surfacing AUTH_INVALID would wrongly tell the user to add a key they have.
    throw new HunterError(
      'DEPENDENCY_UNAVAILABLE',
      `Could not read user secrets: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }
  const apiKey = userSecrets?.HUNTER_API_KEY ?? userSecrets?.hunter_api_key;
  if (!apiKey) {
    throw new HunterError(
      'AUTH_INVALID',
      'No Hunter API key configured. Add HUNTER_API_KEY in this app\'s user secrets (get one at hunter.io/api-keys).',
    );
  }
  return apiKey;
}
