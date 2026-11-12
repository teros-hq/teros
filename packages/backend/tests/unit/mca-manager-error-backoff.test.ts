/**
 * Unit — getErrorBackoffMs & checkErrorCooldown (adaptive backoff for error MCAs).
 *
 * El bug: getOrSpawn() bloqueaba permanentemente un MCA tras maxRestarts (3)
 * fallos — lanzaba sin cooldown ni recuperación. Si el error era transitorio
 * (network blip, credencial temporal), el MCA quedaba muerto para siempre hasta
 * restart manual del backend.
 *
 * El fix: backoff adaptativo (60s → 60s → 3min → 5min → 15min permanente).
 * Tras cada fallo se registra errorAt; getOrSpawn() comprueba si el cooldown
 * ha elapsed antes de permitir un retry. El restartCount sigue subiendo, así
 * que el backoff crece con fallos consecutivos.
 */

import { describe, expect, it } from 'bun:test'
import { getErrorBackoffMs, checkErrorCooldown, computeNextRestartCount } from '../../src/services/mca-manager.types'

describe('getErrorBackoffMs', () => {
  it('schedule: 0→60s, 1→60s, 2→3min, 3→5min, 4+→15min (permanent cap)', () => {
    expect(getErrorBackoffMs(0)).toBe(60_000)
    expect(getErrorBackoffMs(1)).toBe(60_000)
    expect(getErrorBackoffMs(2)).toBe(3 * 60_000)
    expect(getErrorBackoffMs(3)).toBe(5 * 60_000)
    expect(getErrorBackoffMs(4)).toBe(15 * 60_000)
  })

  it('caps at 15min for high restart counts (no unbounded growth)', () => {
    expect(getErrorBackoffMs(5)).toBe(15 * 60_000)
    expect(getErrorBackoffMs(10)).toBe(15 * 60_000)
    expect(getErrorBackoffMs(100)).toBe(15 * 60_000)
  })
})

describe('checkErrorCooldown', () => {
  it('non-error status → canRetry=true (no cooldown for ready/standby/starting)', () => {
    expect(checkErrorCooldown({ status: 'ready', restartCount: 0 })).toEqual({ canRetry: true, remainingMs: 0, cooldownMs: 0 })
    expect(checkErrorCooldown({ status: 'standby', restartCount: 2 })).toEqual({ canRetry: true, remainingMs: 0, cooldownMs: 0 })
  })

  it('undefined existing → canRetry=true', () => {
    expect(checkErrorCooldown(undefined)).toEqual({ canRetry: true, remainingMs: 0, cooldownMs: 0 })
  })

  it('error without errorAt → canRetry=true (legacy entries without the field)', () => {
    const result = checkErrorCooldown({ status: 'error', restartCount: 1 })
    expect(result.canRetry).toBe(true)
    expect(result.remainingMs).toBe(0)
    expect(result.cooldownMs).toBe(60_000) // still reports the configured cooldown
  })

  it('error within cooldown → canRetry=false with remainingMs', () => {
    const errorAt = new Date(Date.now() - 10_000) // 10s ago
    const result = checkErrorCooldown({ status: 'error', restartCount: 0, errorAt })
    expect(result.canRetry).toBe(false)
    expect(result.cooldownMs).toBe(60_000)
    expect(result.remainingMs).toBeGreaterThan(45_000) // ~50s remaining
    expect(result.remainingMs).toBeLessThanOrEqual(50_000)
  })

  it('error after cooldown elapsed → canRetry=true', () => {
    const errorAt = new Date(Date.now() - 61_000) // 61s ago, cooldown is 60s
    const result = checkErrorCooldown({ status: 'error', restartCount: 0, errorAt })
    expect(result.canRetry).toBe(true)
    expect(result.remainingMs).toBe(0)
    expect(result.cooldownMs).toBe(60_000)
  })

  it('higher restartCount → longer cooldown (3min at count=2)', () => {
    const errorAt = new Date(Date.now() - 120_000) // 2min ago
    const result = checkErrorCooldown({ status: 'error', restartCount: 2, errorAt })
    expect(result.canRetry).toBe(false)
    expect(result.cooldownMs).toBe(3 * 60_000)
    expect(result.remainingMs).toBeGreaterThan(30_000) // ~1min remaining
    expect(result.remainingMs).toBeLessThanOrEqual(60_000)
  })

  it('15min permanent cap at restartCount=4+', () => {
    const errorAt = new Date(Date.now() - 14 * 60_000) // 14min ago
    const result = checkErrorCooldown({ status: 'error', restartCount: 5, errorAt })
    expect(result.canRetry).toBe(false)
    expect(result.cooldownMs).toBe(15 * 60_000)
    expect(result.remainingMs).toBeGreaterThan(30_000) // ~1min remaining
  })

  it('custom now parameter works correctly', () => {
    const errorAt = new Date('2026-01-01T10:00:00Z')
    const now = new Date('2026-01-01T10:00:30Z') // 30s later
    const result = checkErrorCooldown({ status: 'error', restartCount: 0, errorAt }, now)
    expect(result.canRetry).toBe(false)
    expect(result.remainingMs).toBe(30_000) // 60s - 30s = 30s
  })
})

describe('checkErrorCooldown + computeNextRestartCount integration', () => {
  it('simulates full retry cycle: error → cooldown → retry → error → longer cooldown', () => {
    // First failure: restartCount=0, 60s cooldown
    let managed = { status: 'error' as const, restartCount: 0, errorAt: new Date() }
    
    // Within cooldown → blocked
    expect(checkErrorCooldown(managed).canRetry).toBe(false)
    
    // After 61s → allowed
    const after61s = new Date(managed.errorAt!.getTime() + 61_000)
    expect(checkErrorCooldown(managed, after61s).canRetry).toBe(true)
    
    // getOrSpawn retries → spawn fails again → computeNextRestartCount increments
    const nextCount = computeNextRestartCount(managed)
    expect(nextCount).toBe(1) // 0 + 1 = 1
    
    // Second failure: restartCount=1, still 60s cooldown
    managed = { status: 'error' as const, restartCount: nextCount, errorAt: after61s }
    expect(getErrorBackoffMs(managed.restartCount)).toBe(60_000)
    
    // Third failure: restartCount=2, now 3min cooldown
    const nextCount2 = computeNextRestartCount(managed)
    expect(nextCount2).toBe(2)
    expect(getErrorBackoffMs(nextCount2)).toBe(3 * 60_000)
    
    // Fourth failure: restartCount=3, 5min cooldown
    const nextCount3 = computeNextRestartCount({ status: 'error', restartCount: nextCount2 })
    expect(nextCount3).toBe(3)
    expect(getErrorBackoffMs(nextCount3)).toBe(5 * 60_000)
    
    // Fifth failure: restartCount=4, 15min permanent cap
    const nextCount4 = computeNextRestartCount({ status: 'error', restartCount: nextCount3 })
    expect(nextCount4).toBe(4)
    expect(getErrorBackoffMs(nextCount4)).toBe(15 * 60_000)
    
    // Sixth failure: restartCount=5, still 15min (capped)
    const nextCount5 = computeNextRestartCount({ status: 'error', restartCount: nextCount4 })
    expect(nextCount5).toBe(5)
    expect(getErrorBackoffMs(nextCount5)).toBe(15 * 60_000)
  })

  it('NO PERMANENT BLOCK: even after many failures, cooldown always eventually elapses', () => {
    // The key property: unlike the old maxRestarts permanent throw,
    // the backoff always allows retry after the cooldown period.
    let restartCount = 10 // way past old maxRestarts of 3
    const cooldownMs = getErrorBackoffMs(restartCount)
    const errorAt = new Date()
    
    // Within cooldown → blocked
    expect(checkErrorCooldown({ status: 'error', restartCount, errorAt }).canRetry).toBe(false)
    
    // After cooldown → allowed (this is the fix — old code would throw permanently)
    const afterCooldown = new Date(errorAt.getTime() + cooldownMs + 1)
    expect(checkErrorCooldown({ status: 'error', restartCount, errorAt }, afterCooldown).canRetry).toBe(true)
  })
})
