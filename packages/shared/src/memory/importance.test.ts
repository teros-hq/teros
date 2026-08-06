/**
 * Unit — importance scoring (TER-470). Función pura: tabla exhaustiva de las
 * 5 reglas + clamps + coherencia level↔retention↔cleanup.
 *
 * (Property-based con fast-check queda para cuando TER-469 — que introduce la
 * dep al lockfile — esté en dev; aquí la tabla cubre el dominio discreto.)
 */

import { describe, expect, it } from 'bun:test';
import {
  calculateImportance,
  getImportanceLevel,
  getRetentionDays,
  shouldCleanup,
} from './importance.js';

describe('calculateImportance — reglas individuales', () => {
  it('base: mensaje normal sin señales → 0.3', () => {
    expect(calculateImportance({ userMessage: 'cuéntame sobre el clima', assistantResponse: 'r' })).toBe(0.3);
  });

  it('+0.3 con archivos modificados', () => {
    expect(
      calculateImportance({ userMessage: 'x', assistantResponse: 'r', filesModified: ['a.ts'] }),
    ).toBeCloseTo(0.6, 10);
  });

  it('+0.2 con comandos ejecutados', () => {
    expect(
      calculateImportance({ userMessage: 'x', assistantResponse: 'r', commandsRun: ['ls'] }),
    ).toBeCloseTo(0.5, 10);
  });

  it('+0.2 con mensaje largo (>200 chars) — boundary: 200 exacto NO suma', () => {
    expect(calculateImportance({ userMessage: 'a'.repeat(201), assistantResponse: 'r' })).toBeCloseTo(0.5, 10);
    expect(calculateImportance({ userMessage: 'a'.repeat(200), assistantResponse: 'r' })).toBe(0.3);
  });

  it('+0.2 con keyword crítica (case-insensitive, como substring)', () => {
    expect(calculateImportance({ userMessage: 'hay un BUG en producción', assistantResponse: 'r' })).toBeCloseTo(0.5, 10);
    expect(calculateImportance({ userMessage: 'vamos a deployar', assistantResponse: 'r' })).toBeCloseTo(0.5, 10); // 'deploy' substring
  });

  it('-0.3 con mensaje trivial EXACTO (tras trim, no substring)', () => {
    expect(calculateImportance({ userMessage: '  hola  ', assistantResponse: 'r' })).toBeCloseTo(0.1, 10); // clamp inferior: 0.3-0.3=0 → 0.1
    // 'hola amigo' NO es trivial (match exacto, no substring)
    expect(calculateImportance({ userMessage: 'hola amigo', assistantResponse: 'r' })).toBe(0.3);
  });

  it('acumulación: todas las señales positivas → clamp superior 1.0', () => {
    expect(
      calculateImportance({
        userMessage: `URGENT: fix del bug en producción ${'x'.repeat(200)}`,
        assistantResponse: 'r',
        filesModified: ['a.ts'],
        commandsRun: ['git push'],
      }),
    ).toBe(1.0); // 0.3+0.3+0.2+0.2+0.2 = 1.2 → clamp 1.0
  });

  it('el clamp inferior garantiza ≥0.1 incluso para triviales', () => {
    expect(calculateImportance({ userMessage: 'ping', assistantResponse: '' })).toBeCloseTo(0.1, 10);
  });

  it('arrays vacíos NO suman (boundary 0 vs 1 elementos)', () => {
    expect(
      calculateImportance({ userMessage: 'x', assistantResponse: 'r', filesModified: [], commandsRun: [] }),
    ).toBe(0.3);
  });
});

describe('getImportanceLevel / getRetentionDays — boundaries exactos', () => {
  it.each([
    [0.1, 'low', 30],
    [0.29, 'low', 30],
    [0.3, 'medium', 90], // boundary: < 0.3 es low → 0.3 ya es medium
    [0.69, 'medium', 90],
    [0.7, 'high', null], // boundary: < 0.7 es medium → 0.7 ya es high
    [1.0, 'high', null],
  ])('score %p → level %p, retention %p', (score, level, retention) => {
    expect(getImportanceLevel(score as number)).toBe(level as 'low' | 'medium' | 'high');
    expect(getRetentionDays(score as number)).toBe(retention as number | null);
  });
});

describe('shouldCleanup — coherencia con retention', () => {
  it('high (retention null) NUNCA se limpia, da igual la edad', () => {
    expect(shouldCleanup(0.9, 10_000)).toBe(false);
  });

  it('low: límite estricto en 30 días (30 exacto NO limpia, 31 sí)', () => {
    expect(shouldCleanup(0.2, 30)).toBe(false);
    expect(shouldCleanup(0.2, 31)).toBe(true);
  });

  it('medium: límite en 90 días', () => {
    expect(shouldCleanup(0.5, 90)).toBe(false);
    expect(shouldCleanup(0.5, 91)).toBe(true);
  });
});
