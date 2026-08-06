import { describe, expect, it } from 'vitest'
import {
  assembleBlob,
  calculateMetering,
  expandSamples,
  formatDuration,
  normalizeMetering,
} from './InputComposer.audio'

/**
 * TER-461 — helpers puros de audio/waveform del composer (extraídos de
 * InputComposer.web a InputComposer.audio para testear el DSP sin el grafo de UI).
 * El grueso del composer (grabación Web Audio / recordrtc) es territorio smoke/e2e.
 * Fronteras CORRECT: existence, range, clamp, fencepost.
 */

describe('formatDuration — m:ss', () => {
  it('rellena los segundos a 2 dígitos y parte minutos', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(5)).toBe('0:05') // padStart en <10
    expect(formatDuration(59)).toBe('0:59')
    expect(formatDuration(60)).toBe('1:00') // frontera de minuto
    expect(formatDuration(65)).toBe('1:05')
    expect(formatDuration(600)).toBe('10:00')
  })
})

describe('normalizeMetering — map [-50,0]→[0,1] con clamp [0.1,1]', () => {
  it('mapea el rango central', () => {
    expect(normalizeMetering(0)).toBe(1) // máximo
    expect(normalizeMetering(-25)).toBeCloseTo(0.5, 5)
  })
  it('clampa por debajo a 0.1 y por encima a 1', () => {
    expect(normalizeMetering(-50)).toBe(0.1) // el mínimo del rango cae en el clamp inferior
    expect(normalizeMetering(-60)).toBe(0.1) // por debajo → clamp
    expect(normalizeMetering(10)).toBe(1) // por encima → clamp
  })
})

describe('expandSamples — interpolación lineal a targetLength', () => {
  it('rellena con 0.3 cuando no hay muestras', () => {
    expect(expandSamples([], 4)).toEqual([0.3, 0.3, 0.3, 0.3])
  })
  it('recorta cuando ya hay suficientes muestras (length >= target)', () => {
    expect(expandSamples([1, 2, 3, 4, 5], 3)).toEqual([1, 2, 3])
    expect(expandSamples([1, 2, 3], 3)).toEqual([1, 2, 3]) // frontera igual
  })
  it('interpola los extremos exactos y el punto medio', () => {
    expect(expandSamples([0, 1], 3)).toEqual([0, 0.5, 1])
    expect(expandSamples([0, 10], 5)).toEqual([0, 2.5, 5, 7.5, 10])
  })
})

describe('assembleBlob — ensambla chunks o null', () => {
  it('devuelve null sin chunks', () => {
    expect(assembleBlob([])).toBeNull()
  })
  it('conserva el type del primer chunk', () => {
    const blob = assembleBlob([new Blob(['a'], { type: 'audio/webm' })])
    expect(blob).not.toBeNull()
    expect(blob?.type).toBe('audio/webm')
    expect(blob?.size).toBeGreaterThan(0)
  })
  it('cae a audio/mp4 cuando el primer chunk no trae type', () => {
    const blob = assembleBlob([new Blob([''], { type: '' })])
    expect(blob?.type).toBe('audio/mp4')
  })
})

describe('calculateMetering — RMS → dB con clamp [-60, 0]', () => {
  const fakeAnalyser = (fill: number, fftSize = 16) =>
    ({
      fftSize,
      getByteTimeDomainData: (arr: Uint8Array) => arr.fill(fill),
    }) as unknown as AnalyserNode

  it('silencio (centro 128) → -60 (clamp inferior)', () => {
    expect(calculateMetering(fakeAnalyser(128))).toBe(-60)
  })
  it('señal fuerte (extremo 255) → por encima de -60, dentro de [-60,0]', () => {
    const db = calculateMetering(fakeAnalyser(255))
    expect(db).toBeGreaterThan(-60)
    expect(db).toBeLessThanOrEqual(0)
  })
})
