import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Adoption invariant (lint-as-test). Every surface where the user picks a
 * model/provider must wire the retention guard + confirmation modal. The
 * `stub-window-content` vitest plugin replaces the *WindowContent modules with
 * no-ops, so a render test CANNOT cover this — we assert against the source on
 * disk instead. A refactor that drops the guard from any surface fails here,
 * not silently in production (cf. the TerosCore renderer-registration incident).
 */
const here = dirname(fileURLToPath(import.meta.url))

// Onboarding's ProviderStep was removed (every user runs on Teros by default),
// so the model/provider pickers are now the agent-cores, agent-config and
// providers windows.
const SURFACES: Record<string, string> = {
  AgentCoresWindow: '../../windows/AgentCoresWindow/AgentCoresWindowContent.tsx',
  AgentWindow: '../../windows/AgentWindow/AgentWindowContent.tsx',
  ProvidersWindow: '../../windows/ProvidersWindow/ProvidersWindowContent.tsx',
}

describe('retention guard adoption', () => {
  for (const [name, rel] of Object.entries(SURFACES)) {
    it(`${name} wires useRetentionGuard + RetentionConfirmModal`, () => {
      const src = readFileSync(resolve(here, rel), 'utf8')
      expect(src).toContain('useRetentionGuard')
      expect(src).toContain('RetentionConfirmModal')
    })
  }
})
