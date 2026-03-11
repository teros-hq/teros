/**
 * Backend Configuration
 *
 * Infrastructure config from environment variables.
 * Secrets (API keys, credentials) are managed by SecretsManager (.secrets/).
 *
 * Env vars kept here are strictly infrastructure concerns:
 * - PORT, MCA_BASE_PATH, STATIC_BASE_URL, UPLOADS_PATH, VOLUMES_BASE_PATH
 *
 * Everything else (API keys, DB credentials, session secrets) lives in
 * .secrets/system/*.json and is accessed via SecretsManager at runtime.
 */

import { config as dotenvConfig } from "dotenv"
import { dirname, resolve } from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// Repo root is 3 levels up from src/config.ts (src -> backend -> packages -> root)
const repoRoot = resolve(__dirname, "../../..")

/**
 * Helper to get required environment variable
 * Throws if not defined
 */
function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

/**
 * Helper to get optional environment variable
 */
function optionalEnv(name: string): string | undefined {
  return process.env[name]
}

// Load .env file from repo root (or .env.test for tests)
const envFile =
  process.env.NODE_ENV === "test"
    ? resolve(__dirname, "..", ".env.test")
    : resolve(repoRoot, ".env")
dotenvConfig({ path: envFile })

const port = parseInt(optionalEnv("PORT") || "3000", 10)

export const config = {
  server: {
    port,
  },
  uploads: {
    // Directory for storing uploaded files (audio, images, etc.)
    basePath: optionalEnv("UPLOADS_PATH") || "./uploads",
  },
  mca: {
    // Base path where MCAs are installed
    basePath: requireEnv("MCA_BASE_PATH"),
  },
  volumes: {
    // Base path for user and workspace volumes
    basePath: optionalEnv("VOLUMES_BASE_PATH") || "/data/volumes",
    // Default quota for user volumes (bytes, 0 = unlimited)
    defaultUserQuota: parseInt(optionalEnv("USER_VOLUME_QUOTA") || "0", 10),
    // Default quota for workspace volumes (bytes, 0 = unlimited)
    defaultWorkspaceQuota: parseInt(optionalEnv("WORKSPACE_VOLUME_QUOTA") || "0", 10),
  },
  static: {
    // Base URL for static files (avatars, etc.)
    baseUrl: optionalEnv("STATIC_BASE_URL") || "http://localhost:3000/static",
  },
  email: {
    // From address for emails (not a secret, just config)
    fromEmail: optionalEnv("EMAIL_FROM") || "hello@teros.ai",
    fromName: optionalEnv("EMAIL_FROM_NAME") || "Teros",
  },
  // Note: All secrets (DB, auth, API keys, OAuth) are loaded from
  // .secrets/system/*.json via SecretsManager. See secrets/types.ts.
} as const
