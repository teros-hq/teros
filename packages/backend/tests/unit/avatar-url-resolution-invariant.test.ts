/**
 * Invariante estructural: avatarUrl SIEMPRE resuelto antes de llegar al frontend.
 *
 * El avatar de un agente se persiste como FILENAME desnudo (`iria-avatar.jpg`).
 * `buildAvatarUrl()` (lib/avatar-url.ts) lo convierte en URL pública. El bug
 * (TER-605) era ASIMÉTRICO: unos paths resolvían y otros devolvían el nombre
 * crudo → el frontend lo metía en <img src> relativo a la app → 404.
 *
 * Hay DOS fuentes de avatarUrl de salida, y el invariante cubre ambas:
 *   1. `BoardService.resolveAgents()` — resolver de PRESENTACIÓN del dominio board;
 *      lo consumen ~8 boundaries (get-board, get-task, list-tasks, board-commands,
 *      queries-board-read). Resolver AHÍ cubre todos de raíz → esos boundaries
 *      NO re-resuelven (heredan) y por eso NO están en SCAN_FILES.
 *   2. Boundaries que leen la colección `agents` DIRECTO de Mongo (admin-api,
 *      mca-resources REST, queries-board-runner, message-handler, agent/*): cada
 *      uno resuelve en su sitio.
 *
 * Build-green NO basta (el campo es `string` opcional, sin tipo que ate la
 * resolución). Este guard escanea el SOURCE: revertir un fix, reintroducir la
 * construcción manual con process.env, o añadir una salida Mongo-directa sin
 * resolver → rojo. Patrón: agent-usage-wiring.test.ts + scheduler parity.
 */

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(__dirname, '../../src')
const read = (rel: string): string => readFileSync(resolve(SRC, rel), 'utf8')

/**
 * Cada sitio DEBE resolver con buildAvatarUrl. Afirmación positiva dirigida —
 * revertir un fix a crudo lo pone en rojo.
 */
const RESOLVED_OUTPUT_SITES: Array<[string, RegExp]> = [
  // Punto canónico del dominio board: cubre get-board/get-task/list-tasks/
  // board-commands/queries-board-read de raíz (TER-605 review).
  ['services/board-service.ts', /avatarUrl:\s*buildAvatarUrl\(a\.avatarUrl\)/],
  // Boundaries Mongo-directo arreglados en TER-607.
  ['handlers/domains/admin-api/agents.ts', /avatarUrl:\s*buildAvatarUrl\(a\.avatarUrl/],
  ['handlers/domains/admin-api/agents.ts', /avatarUrl:\s*buildAvatarUrl\(\(agent as any\)/],
  ['routes/mca-resources-handlers.ts', /avatarUrl:\s*buildAvatarUrl\(a\.avatarUrl\)/],
  ['routes/mca-resources-handlers.ts', /avatarUrl:\s*buildAvatarUrl\(agent\.avatarUrl\)/],
  ['services/mca-connection-manager.queries-board-runner.ts', /avatarUrl:\s*buildAvatarUrl\(avatarFilename\)/],
  ['handlers/message-handler.ts', /agentAvatar\s*=\s*buildAvatarUrl\(agent\.avatarUrl\)/],
  // Ya estaban bien — protección contra regresión por refactor upstream.
  // El payload de `agent.created` resuelve el avatar en el helper compartido
  // buildAgentCreatedPayload (lo consumen agent/create.ts y mca-resources-handlers.ts);
  // ése es ahora el punto canónico de resolución para AMBOS paths de creación (TER-611).
  ['lib/agent-payload.ts', /avatarUrl:\s*buildAvatarUrl\(agent\.avatarUrl\)/],
  ['handlers/domains/agent/list.ts', /avatarUrl:\s*buildAvatarUrl\(/],
  ['handlers/domains/agent/update.ts', /avatarUrl:\s*buildAvatarUrl\(/],
  ['handlers/domains/agent/list-cores.ts', /avatarUrl:\s*buildAvatarUrl\(/],
  ['handlers/domains/agent/update-core.ts', /avatarUrl:\s*buildAvatarUrl\(/],
  ['handlers/domains/agent/create-core.ts', /avatarUrl:\s*buildAvatarUrl\(/],
  ['handlers/domains/board/list-board-agents.ts', /avatarUrl:\s*buildAvatarUrl\(/],
  ['services/channel-manager.ts', /avatarUrl:\s*buildAvatarUrl\(agent\.avatarUrl\)/],
]

describe('avatarUrl · resolución antes del frontend (invariante estructural)', () => {
  for (const [file, pattern] of RESOLVED_OUTPUT_SITES) {
    it(`${file} resuelve con buildAvatarUrl (${pattern.source.slice(0, 40)}…)`, () => {
      expect(read(file)).toMatch(pattern)
    })
  }

  it('message-handler NO reintroduce la construcción manual con process.env.STATIC_BASE_URL', () => {
    expect(read('handlers/message-handler.ts')).not.toMatch(/process\.env\.STATIC_BASE_URL/)
  })

  /**
   * Cobertura: en los archivos que leen `agents` DIRECTO de Mongo, NINGUNA
   * propiedad `*avatarUrl:` puede quedar cruda. Exime tipos (`?:`/`: string`),
   * projections (`: 1`), escrituras (`$set`) y valores ya resueltos. Los
   * boundaries de board (get-board, queries-board-read, get-task, list-tasks,
   * board-commands) NO se escanean: heredan de resolveAgents (cubierto arriba).
   */
  const SCAN_FILES = [
    'handlers/domains/admin-api/agents.ts',
    'routes/mca-resources-handlers.ts',
    'services/mca-connection-manager.queries-board-runner.ts',
  ]

  for (const file of SCAN_FILES) {
    it(`${file} no devuelve ninguna propiedad avatarUrl cruda`, () => {
      const offenders = read(file)
        .split('\n')
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        .filter(({ line }) => /[Aa]vatarUrl:/.test(line)) // propiedad avatarUrl/assigneeAvatarUrl
        .filter(({ line }) => !/[Aa]vatarUrl\?:/.test(line)) // no tipo opcional
        .filter(({ line }) => !/[Aa]vatarUrl:\s*(1|string|number)\b/.test(line)) // no projection/tipo
        .filter(({ line }) => !line.includes('$set')) // no escritura a Mongo
        .filter(({ line }) => !/[Aa]vatarUrl:\s*buildAvatarUrl\(/.test(line)) // no resuelto
      expect(offenders).toEqual([])
    })
  }
})
