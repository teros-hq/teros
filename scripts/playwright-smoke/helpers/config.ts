/**
 * Smoke suite config. Everything overridable by env so the same suite runs
 * against local dev, a worktree, or CI.
 */
import { readFileSync } from "node:fs"

export type Creds = { email: string; password: string }

export const CONFIG = {
  targetUrl: process.env.TARGET_URL || "http://localhost:8081",
  backendUrl: process.env.BACKEND_URL || "http://localhost:10001",
  users: {
    user1: { email: "playwright1@test.com", password: "test1234" },
    user2: { email: "playwright2@test.com", password: "test1234" },
    // Super admin — used by core-rollout.spec.ts (rollout ops are super-only).
    user3: { email: "playwright3@test.com", password: "test1234" },
  },
  fixturesPath: process.env.SMOKE_FIXTURES || "/tmp/ter304-fixtures.json",
  authDir: process.env.SMOKE_AUTH_DIR || `${__dirname}/../.auth`,
}

// seed.mjs persists only userId + sharedWorkspaceId. agentId/privateWorkspaceId
// are derived live via getPrimaryIds (window.teros), not from this file.
export type Fixtures = {
  user1: { email: string; userId: string }
  user2: { email: string; userId: string }
  user3: { email: string; userId: string; privateWorkspaceId: string }
  sharedWorkspaceId: string
}

let _fixtures: Fixtures | null = null

/** Loads seed fixtures; throws a clear message if seed.mjs hasn't run. */
export function loadFixtures(): Fixtures {
  if (_fixtures) return _fixtures
  try {
    _fixtures = JSON.parse(readFileSync(CONFIG.fixturesPath, "utf8"))
    return _fixtures as Fixtures
  } catch {
    throw new Error(
      `No se encontraron fixtures en ${CONFIG.fixturesPath}. Corre primero: node scripts/playwright-smoke/seed.mjs`,
    )
  }
}
