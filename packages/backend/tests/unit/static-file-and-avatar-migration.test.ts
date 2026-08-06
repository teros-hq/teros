/**
 * TER-608 — defensa del static serve + migración de avatarUrl.
 *
 * - resolveStaticFilePath: decodifica percent-encoding (':' histórico), bloquea
 *   path traversal (incl. mcaId '..' que re-anclaría la raíz — review TER-608) y
 *   exige el prefijo /static/.
 * - toBareAvatarFilename + migration.up: normaliza SOLO URLs que apuntan a nuestra
 *   base (self-ref/double-wrap), sin tocar bare/externas/con ':'. Idempotente.
 */

import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { config } from '../../src/config'
import { STATIC_DIR, resolveStaticFilePath } from '../../src/bootstrap/http-server'
import avatarMigration, {
  toBareAvatarFilename,
} from '../../src/migrations/20260623_001_normalize_avatar_urls'

describe('resolveStaticFilePath · decode + anti-traversal', () => {
  it('resuelve un avatar normal dentro de STATIC_DIR', () => {
    expect(resolveStaticFilePath('/static/iria-avatar.jpg')).toBe(
      resolve(STATIC_DIR, 'iria-avatar.jpg'),
    )
  })

  it('decodifica %3A → ":" para servir un avatar histórico con dos puntos', () => {
    expect(resolveStaticFilePath('/static/agent%3Airia-avatar-2a26a40a.png')).toBe(
      resolve(STATIC_DIR, 'agent:iria-avatar-2a26a40a.png'),
    )
  })

  it('bloquea traversal con ../ codificado (devuelve null)', () => {
    expect(resolveStaticFilePath('/static/..%2f..%2f..%2fetc%2fpasswd')).toBeNull()
  })

  it('bloquea traversal con ../ literal (devuelve null)', () => {
    expect(resolveStaticFilePath('/static/../../etc/passwd')).toBeNull()
  })

  it('bloquea mcaId ".." que re-anclaría la raíz del MCA (devuelve null)', () => {
    expect(resolveStaticFilePath('/static/mcas/../static/secret.png')).toBeNull()
  })

  it('devuelve null ante una secuencia URI malformada', () => {
    expect(resolveStaticFilePath('/static/%E0%A4%A')).toBeNull()
  })

  it('bloquea traversal que intenta escapar del static dir de un MCA', () => {
    expect(resolveStaticFilePath('/static/mcas/mca.test/..%2f..%2f..%2fsecret.json')).toBeNull()
  })

  it('devuelve null si la URL no empieza por /static/ (contrato)', () => {
    expect(resolveStaticFilePath('/api/upload/avatar/x')).toBeNull()
  })
})

describe('toBareAvatarFilename', () => {
  // Bases FIJAS y variadas (NO config.static.baseUrl): el bug de CI fue depender
  // del formato del entorno. La función debe reducir igual con cualquier shape.
  const BASES = [
    'http://localhost:3000/static', // con segmento /static
    'http://localhost:3000/static/', // con trailing slash
    'http://localhost:3000', // sin /static
    'https://be.teros.ai/static', // host real de prod
  ]

  for (const base of BASES) {
    it(`reduce una URL self-referencial a su filename (base="${base}")`, () => {
      expect(toBareAvatarFilename(`${base}/iria-avatar.jpg`, base)).toBe('iria-avatar.jpg')
    })

    it(`reduce una URL doble-wrapeada al último segmento (base="${base}")`, () => {
      expect(toBareAvatarFilename(`${base}/${base}/x.png`, base)).toBe('x.png')
    })

    it(`deja intacto un bare filename (base="${base}")`, () => {
      expect(toBareAvatarFilename('iria-avatar.jpg', base)).toBe('iria-avatar.jpg')
    })

    it(`deja intacto un valor con ":" que no es URL nuestra (base="${base}")`, () => {
      expect(toBareAvatarFilename('agent:iria-avatar-x.png', base)).toBe('agent:iria-avatar-x.png')
    })

    it(`deja intacta una URL EXTERNA que contenga /static/ (base="${base}")`, () => {
      const external = 'https://cdn.example.com/static/avatars/y.png'
      expect(toBareAvatarFilename(external, base)).toBe(external)
    })
  }
})

// Mock mínimo de Mongo: find({avatarUrl:{$type:'string'}}) como async-iterable
// + updateOne que aplica $set al doc en memoria.
function mockMigrationDb(docsByColl: Record<string, any[]>) {
  const updates: Array<{ coll: string; id: any; set: any }> = []
  const db = {
    collection(name: string) {
      return {
        find: (query: any) => ({
          async *[Symbol.asyncIterator]() {
            // Reproduce { avatarUrl: { $type: 'string' } }: yield los doc con avatarUrl string.
            const wantsString = query?.avatarUrl?.$type === 'string'
            for (const d of docsByColl[name] ?? []) {
              if (wantsString && typeof d.avatarUrl === 'string') {
                yield d
              }
            }
          },
        }),
        updateOne: async (filter: any, update: any) => {
          updates.push({ coll: name, id: filter._id, set: update.$set })
          const d = (docsByColl[name] ?? []).find((x) => x._id === filter._id)
          if (d) Object.assign(d, update.$set)
        },
      }
    },
  }
  return { db: db as any, updates }
}

describe('migration normalize_avatar_urls · up', () => {
  it('normaliza solo URLs de nuestra base; deja externas/bare/":" intactas; idempotente', async () => {
    const base = config.static.baseUrl
    const docsByColl = {
      agents: [
        { _id: '1', avatarUrl: `${base}/iria-avatar.jpg` }, // nuestra → bare
        { _id: '2', avatarUrl: 'iria-avatar.jpg' }, // bare → intacto
        { _id: '3', avatarUrl: 'agent:iria-avatar-x.png' }, // ':' → intacto
        { _id: '4', avatarUrl: 'https://cdn.example.com/static/avatars/y.png' }, // externa → intacta
      ],
      agent_cores: [{ _id: 'c1', avatarUrl: `${base}/${base}/x.png` }], // double-wrap → último segmento
    }
    const { db, updates } = mockMigrationDb(docsByColl)

    await avatarMigration.up(db)

    expect(docsByColl.agents[0].avatarUrl).toBe('iria-avatar.jpg')
    expect(docsByColl.agents[1].avatarUrl).toBe('iria-avatar.jpg')
    expect(docsByColl.agents[2].avatarUrl).toBe('agent:iria-avatar-x.png')
    expect(docsByColl.agents[3].avatarUrl).toBe('https://cdn.example.com/static/avatars/y.png')
    expect(docsByColl.agent_cores[0].avatarUrl).toBe('x.png')

    const updatesAfterFirst = updates.length
    expect(updatesAfterFirst).toBe(2) // solo doc 1 (agents) + c1 (cores)

    await avatarMigration.up(db)
    expect(updates.length).toBe(updatesAfterFirst) // idempotente
  })
})
