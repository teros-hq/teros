/**
 * Unit test — lógica de decisión del refresh lazy OAuth en /secrets/user (TER-388).
 *
 * Cubre los helpers puros que deciden CUÁNDO refrescar el access_token antes de
 * servirlo al contenedor. El flujo completo (llamar mcaOAuth.refreshToken +
 * re-leer credenciales) se valida en el smoke contra Gmail real.
 */

import { describe, expect, it } from 'bun:test'

// mca-callback-routes importa config.ts, que exige MCA_BASE_PATH al cargar el
// módulo. En dev el `.env` lo provee; en CI/checkouts limpios no existe, así
// que lo fijamos ANTES del import (dinámico, para que el set corra primero).
process.env.MCA_BASE_PATH ??= '/tmp/mcas'
const { parseExpiryToMs, shouldRefreshOAuthToken } = await import(
  '../../src/routes/mca-callback-routes'
)

const NOW = Date.now()
const ONE_HOUR = 60 * 60 * 1000

describe('parseExpiryToMs', () => {
  it('parsea ISO string (formato que persiste el backend)', () => {
    const iso = new Date(NOW).toISOString()
    expect(parseExpiryToMs(iso)).toBe(NOW)
  })

  it('parsea epoch ms numérico (legacy)', () => {
    expect(parseExpiryToMs(NOW)).toBe(NOW)
    expect(parseExpiryToMs(String(NOW))).toBe(NOW)
  })

  it('devuelve null para valores no parseables', () => {
    expect(parseExpiryToMs(undefined)).toBeNull()
    expect(parseExpiryToMs(null)).toBeNull()
    expect(parseExpiryToMs('')).toBeNull()
    expect(parseExpiryToMs('not-a-date')).toBeNull()
  })

  it('NO confunde un epoch en segundos con ISO (regresión del parseInt buggy)', () => {
    // El bug viejo hacía parseInt("2026-06-01T...") = 2026. Aquí el ISO se parsea
    // correctamente a epoch ms, no a 2026.
    const result = parseExpiryToMs('2026-06-01T10:00:00.000Z')
    expect(result).toBe(Date.parse('2026-06-01T10:00:00.000Z'))
    expect(result).toBeGreaterThan(1e12)
  })
})

describe('shouldRefreshOAuthToken', () => {
  it('refresca cuando el token está vencido y hay refresh_token', () => {
    expect(
      shouldRefreshOAuthToken({
        REFRESH_TOKEN: 'rt',
        EXPIRY_DATE: new Date(NOW - ONE_HOUR).toISOString(),
      }),
    ).toBe(true)
  })

  it('refresca cuando expira dentro del margen de 5 min', () => {
    expect(
      shouldRefreshOAuthToken({
        REFRESH_TOKEN: 'rt',
        EXPIRY_DATE: new Date(NOW + 2 * 60 * 1000).toISOString(),
      }),
    ).toBe(true)
  })

  it('NO refresca cuando el token sigue fresco (>5 min)', () => {
    expect(
      shouldRefreshOAuthToken({
        REFRESH_TOKEN: 'rt',
        EXPIRY_DATE: new Date(NOW + ONE_HOUR).toISOString(),
      }),
    ).toBe(false)
  })

  it('NO refresca sin refresh_token (no es nuestro para refrescar)', () => {
    expect(
      shouldRefreshOAuthToken({ EXPIRY_DATE: new Date(NOW - ONE_HOUR).toISOString() }),
    ).toBe(false)
  })

  it('NO refresca sin EXPIRY_DATE (no-OAuth o expiry desconocido)', () => {
    expect(shouldRefreshOAuthToken({ REFRESH_TOKEN: 'rt' })).toBe(false)
    expect(shouldRefreshOAuthToken({ API_KEY: 'k' })).toBe(false)
  })
})
