/**
 * Invariantes del contenido de la guía. MUERDEN: vaciar un body, duplicar un
 * id, dejar un `related` colgando, o que el enum de `get-guide-section` no
 * cubra un topic → rojo. El enum desincronizado es el bug de cobertura clásico
 * (el agente no podría pedir esa sección).
 */

import { describe, expect, it } from 'bun:test';
import { GUIDE_TOPICS } from '../../src/content/topics';
import { TOPIC_IDS } from '../../src/tools/get-section';

const SUMMARY_MAX = 200;

describe('content — topics invariants', () => {
  it('hay topics y son los 13 esperados', () => {
    expect(GUIDE_TOPICS.length).toBe(13);
  });

  it('ids únicos y kebab-case', () => {
    const ids = GUIDE_TOPICS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id, `${id} no es kebab-case`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it.each(GUIDE_TOPICS.map((t) => [t.id, t] as const))(
    '%s: title/summary/body/keywords presentes y válidos',
    (_id, topic) => {
      expect(topic.title.trim().length).toBeGreaterThan(0);
      expect(topic.summary.trim().length).toBeGreaterThan(0);
      expect(topic.summary.length).toBeLessThanOrEqual(SUMMARY_MAX);
      // body sustancial: el agente instruye a partir de él
      expect(topic.body.trim().length).toBeGreaterThan(100);
      expect(topic.keywords.length).toBeGreaterThan(0);
      for (const k of topic.keywords) expect(k.trim().length).toBeGreaterThan(0);
    },
  );

  it('related apunta solo a topics existentes', () => {
    const ids = new Set(GUIDE_TOPICS.map((t) => t.id));
    for (const t of GUIDE_TOPICS) {
      for (const r of t.related ?? []) {
        expect(ids.has(r), `${t.id} → related "${r}" no existe`).toBe(true);
      }
    }
  });
});

describe('content — get-guide-section enum cubre TODOS los topics', () => {
  it('TOPIC_IDS === GUIDE_TOPICS ids (sin sobrantes ni faltantes)', () => {
    expect([...TOPIC_IDS].sort()).toEqual(GUIDE_TOPICS.map((t) => t.id).sort());
  });

  it('cada id del contenido es alcanzable por el enum', () => {
    const enumSet = new Set(TOPIC_IDS);
    for (const t of GUIDE_TOPICS) {
      expect(enumSet.has(t.id), `topic "${t.id}" no está en el enum de get-guide-section`).toBe(
        true,
      );
    }
  });
});
