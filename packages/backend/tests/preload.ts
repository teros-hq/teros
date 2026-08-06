/**
 * bun test preload — runs BEFORE any test file's module graph is linked.
 * (Registered via bunfig.toml `[test].preload` at the repo root and in
 * packages/backend, so it applies whether tests run from either cwd.)
 *
 * MCA_BASE_PATH default: src/config.ts hard-requires it at module load.
 * In dev `.env` provides it; in CI/clean checkouts it does not exist, and
 * whichever test file happens to import config first blows up.
 */
process.env.MCA_BASE_PATH ??= '/tmp/mcas'
