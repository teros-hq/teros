import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NAMES_WITH_AVATARS, getAvatarForName } from '../data/agentPersonalities'

/**
 * TER-606 — lint-as-test (no render): cada nombre marcado en NAMES_WITH_AVATARS
 * debe tener su asset físico en el static dir del backend, con la MISMA extensión
 * que asume getAvatarForName (.jpg). Si no, generar un agente con ese nombre da
 * 404 → avatar roto. Muerde también si se añade un avatar .png/.webp a la
 * whitelist sin actualizar getAvatarForName.
 *
 * Vive en src/test/ (no en src/data/) porque .gitignore ignora cualquier `data/`.
 */
describe('agent avatars · paridad whitelist ↔ assets', () => {
  // El script `test:render` corre con cwd = packages/app → ../backend/static.
  const staticDir = resolve(process.cwd(), '..', 'backend', 'static')

  it('el static dir del backend es accesible (ancla del test)', () => {
    expect(existsSync(staticDir) && statSync(staticDir).isDirectory()).toBe(true)
  })

  it('la whitelist no está vacía (sanity)', () => {
    expect(NAMES_WITH_AVATARS.length).toBeGreaterThan(0)
  })

  for (const name of NAMES_WITH_AVATARS) {
    it(`${name} tiene su fichero ${getAvatarForName(name)} en backend/static`, () => {
      expect(existsSync(resolve(staticDir, getAvatarForName(name)))).toBe(true)
    })
  }
})
