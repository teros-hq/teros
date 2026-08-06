/**
 * Unit — computeNextRestartCount (TER-559).
 *
 * El bug: para MCAs en contenedor, restartCount nunca subía (no hay watchdog que
 * lo incremente, a diferencia de stdio) → el guard `restartCount >= maxRestarts`
 * de getOrSpawn nunca saltaba → un MCA roto se re-spawneaba en cada turno (bucle
 * infinito; lo disparaba el memory hook). Este helper hace que un reintento de un
 * MCA en 'error' cuente como restart (+1), de modo que el guard converge.
 */

import { describe, expect, it } from 'bun:test'
import { computeNextRestartCount } from '../../src/services/mca-manager.types'

describe('computeNextRestartCount (TER-559)', () => {
  it('un MCA en error incrementa el contador (+1) → el guard maxRestarts puede saltar', () => {
    expect(computeNextRestartCount({ status: 'error', restartCount: 0 })).toBe(1)
    expect(computeNextRestartCount({ status: 'error', restartCount: 1 })).toBe(2)
    expect(computeNextRestartCount({ status: 'error', restartCount: 2 })).toBe(3)
  })

  it('un MCA que NO está en error mantiene el contador (standby/starting/ready no son reintentos)', () => {
    expect(computeNextRestartCount({ status: 'standby', restartCount: 0 })).toBe(0)
    expect(computeNextRestartCount({ status: 'starting', restartCount: 2 })).toBe(2)
    expect(computeNextRestartCount({ status: 'ready', restartCount: 1 })).toBe(1)
  })

  it('sin entry previa (primer spawn) → 0', () => {
    expect(computeNextRestartCount(undefined)).toBe(0)
  })

  it('restartCount ausente → tratado como 0', () => {
    // biome-ignore lint/suspicious/noExplicitAny: restartCount opcional en el edge
    expect(computeNextRestartCount({ status: 'error' } as any)).toBe(1)
    // biome-ignore lint/suspicious/noExplicitAny: idem
    expect(computeNextRestartCount({ status: 'standby' } as any)).toBe(0)
  })

  it('CONVERGENCIA: error→error→… alcanza maxRestarts en exactamente maxRestarts pasos (no bucle)', () => {
    // Simula el ciclo de getOrSpawn: cada fallo deja el MCA en 'error' con el
    // nuevo count. Mientras count < maxRestarts el guard NO salta y getOrSpawn
    // reintentaría. Sin el +1 (el bug), count se quedaría en 0 → bucle infinito.
    const maxRestarts = 3
    let count = 0
    let steps = 0
    while (count < maxRestarts) {
      count = computeNextRestartCount({ status: 'error', restartCount: count })
      steps++
      if (steps > 100) throw new Error('no converge: bucle infinito (regresión TER-559)')
    }
    expect(count).toBe(maxRestarts) // llegó al tope → el guard saltará
    expect(steps).toBe(maxRestarts) // en exactamente maxRestarts pasos
  })
})
