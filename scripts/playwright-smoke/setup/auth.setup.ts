/**
 * Setup project: logs in once and persists storageState so every test reuses the
 * session (no repeated 10s login). Also ensures the credential-free teros/Kimi
 * provider on the test agent so @llm specs can get real responses.
 */
import { mkdirSync } from "node:fs"
import { test as setup } from "@playwright/test"
import { CONFIG } from "../helpers/config"
import { login } from "../helpers/login"
import { ensureTerosProvider } from "../helpers/provider"
import { getPrimaryIds } from "../helpers/teros"

setup("authenticate + provider", async ({ page }) => {
  mkdirSync(CONFIG.authDir, { recursive: true })

  await login(page, CONFIG.users.user1, "setup")

  // Idempotent provider setup. Tolerant: @llm specs need it, but health/CRUD don't,
  // so a Fireworks hiccup must not block storageState (the @llm specs skip if absent).
  try {
    const { agentId } = await getPrimaryIds(page)
    if (!agentId) throw new Error("no hay agentes para asignar provider")
    const info = await ensureTerosProvider(page, agentId)
    console.log(`[setup] teros provider ${info.providerId} → agent ${info.agentId}`)
  } catch (e) {
    console.warn(
      `[setup] ⚠️ provider teros no configurado (los @llm se saltarán): ${(e as Error).message}`,
    )
  }

  await page.context().storageState({ path: `${CONFIG.authDir}/user1.json` })
  console.log(`[setup] storageState → ${CONFIG.authDir}/user1.json`)
})

// user2: needed by crossuser.spec.ts (member of the shared workspace). No provider
// (user2 never drives an @llm conversation) — just a persisted session.
setup("authenticate user2", async ({ page }) => {
  mkdirSync(CONFIG.authDir, { recursive: true })
  await login(page, CONFIG.users.user2, "setup2")
  await page.context().storageState({ path: `${CONFIG.authDir}/user2.json` })
  console.log(`[setup] storageState → ${CONFIG.authDir}/user2.json`)
})

// user3: SUPER admin — needed by core-rollout.spec.ts (create-core / set-rollout /
// core-rollout-apply are super-only). Just a persisted session.
setup("authenticate user3 super", async ({ page }) => {
  mkdirSync(CONFIG.authDir, { recursive: true })
  await login(page, CONFIG.users.user3, "setup3")
  await page.context().storageState({ path: `${CONFIG.authDir}/user3.json` })
  console.log(`[setup] storageState → ${CONFIG.authDir}/user3.json`)
})
