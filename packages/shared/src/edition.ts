/**
 * Teros Edition — deployment-mode gating (TER-EDITION).
 *
 * Teros ships in two editions:
 *
 *   - `self-hosted` (default) — the open-source / downloadable build. The user
 *     runs the whole stack on their own machine, so a LOCAL Ollama daemon
 *     (http://localhost:11434 on the backend host) is meaningful and the
 *     `ollama` provider type is fully available.
 *
 *   - `cloud` — Teros-hosted deployments (RAW dev environment, production).
 *     The backend runs on a shared, CPU-only server the user does not own:
 *     running models "locally" there is absurd (nobody's GPU, everyone's
 *     latency). The `ollama` provider type is hidden and refused; `ollama-cloud`
 *     (hosted API) is the supported path in every edition.
 *
 * The edition is a deployment constant, not a feature flag: it cannot vary per
 * user/workspace and it must be readable synchronously from module scope (the
 * provider catalog and the add-handler validation are sync paths). An env var
 * is the natural carrier — one value per deployment, set in the environment of
 * the backend (and at build time for the app via EXPO_PUBLIC_TEROS_EDITION).
 *
 * Default is `self-hosted`: an OSS user who never hears about this variable
 * gets the full experience (local Ollama included). Cloud deployments opt in
 * explicitly with TEROS_EDITION=cloud.
 */

export type TerosEdition = 'self-hosted' | 'cloud';

/** Provider types that only make sense when the backend runs on the user's own machine. */
export const SELF_HOSTED_ONLY_PROVIDER_TYPES = ['ollama'] as const;

/**
 * Read the edition from the environment. Invalid values fall back to
 * `self-hosted` with a console warning (fail-open for OSS, never crashes a
 * deployment over a typo).
 */
export function resolveTerosEdition(raw?: string): TerosEdition {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'self-hosted' || value === 'selfhosted' || value === 'oss') {
    return 'self-hosted';
  }
  if (value === 'cloud') return 'cloud';
  // Unknown value — warn loudly and fall back to the OSS-safe default.
  console.warn(
    `[teros-edition] Unknown TEROS_EDITION value "${raw}" — falling back to 'self-hosted'. ` +
      `Valid values: 'cloud' | 'self-hosted'.`,
  );
  return 'self-hosted';
}

/**
 * The edition of THIS deployment. Read once at module load.
 *
 * Backend: `process.env.TEROS_EDITION`.
 * App (Expo): `EXPO_PUBLIC_TEROS_EDITION` is inlined at build time; this module
 * reads it as a fallback so the same function works in both runtimes.
 */
export const TEROS_EDITION: TerosEdition = resolveTerosEdition(
  typeof process !== 'undefined'
    ? process.env?.TEROS_EDITION ?? (process.env as any)?.EXPO_PUBLIC_TEROS_EDITION
    : undefined,
);

/** `true` when this deployment is a Teros-hosted cloud edition (RAW, production). */
export function isCloudEdition(): boolean {
  return TEROS_EDITION === 'cloud';
}

/** `true` when the given provider type is restricted to the self-hosted edition. */
export function isSelfHostedOnlyProviderType(providerType: string): boolean {
  return (SELF_HOSTED_ONLY_PROVIDER_TYPES as readonly string[]).includes(providerType);
}

/**
 * `true` when the given provider type may be used in THIS deployment.
 * `ollama` (local daemon) → only in self-hosted; everything else → everywhere
 * (`ollama-cloud` included — it is the supported Ollama path in cloud).
 */
export function isProviderTypeAllowedInEdition(providerType: string): boolean {
  if (!isSelfHostedOnlyProviderType(providerType)) return true;
  return !isCloudEdition();
}
