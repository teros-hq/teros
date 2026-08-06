/**
 * Invariante de scopes OAuth (lint-as-test) — mínimo privilegio.
 *
 * Bug original: el manifest pedía ~160 scopes de TODOS los hubs (CMS, Marketing,
 * Social, HubDB, e-commerce, accounting, settings…) aunque las tools solo tocan
 * CRM + conversaciones. HubSpot rechaza el OAuth si se piden scopes de productos
 * que el portal no tiene marcados como required, o por mismatch URL↔config.
 *
 * Este guard hace el error imposible por construcción: falla el build si alguien
 * (a) reintroduce un scope de un hub que el MCA no usa, (b) añade un scope no
 * justificado por ninguna tool, (c) mete algo no-universal en `required` (rompería
 * portales Free), o (d) re-infla la lista. Mantener JUSTIFIED en sync con src/tools.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const manifest = JSON.parse(
  readFileSync(join(import.meta.dir, '../../manifest.json'), 'utf8'),
) as { layers: { auth: { scopes: string[]; optionalScopes: string[] } } };

// Segunda fuente de verdad: lo que `hs project upload` sube al developer portal.
// DEBE ir simétrico con el manifest (ver test de sync abajo). TER-613.
const hsmeta = JSON.parse(
  readFileSync(join(import.meta.dir, '../../src/app/Teros-hsmeta.json'), 'utf8'),
) as { config: { auth: { requiredScopes: string[]; optionalScopes: string[] } } };

const required = manifest.layers.auth.scopes;
const optional = manifest.layers.auth.optionalScopes;
const all = [...required, ...optional];

// El núcleo universal: cada uno es "Any account" en la doc de HubSpot (verificado),
// así que como `required` (scope=) ningún portal los rechaza.
const UNIVERSAL_REQUIRED = [
  'oauth',
  'crm.objects.contacts.read',
  'crm.objects.contacts.write',
  'crm.objects.companies.read',
  'crm.objects.companies.write',
  'crm.objects.deals.read',
  'crm.objects.deals.write',
  'crm.objects.owners.read',
];

// Cada scope del manifest → justificado por una familia de tools del MCA.
// NOTA engagements (note/call/task/email/meeting): NO llevan scope granular.
// HubSpot no expone `crm.objects.{notes,tasks,emails,calls,meetings}.*` para
// public apps de marketplace → `hs project upload` los rechaza con "scope could
// not be recognized". Las engagement tools acceden la Engagements API
// (/crm/v3/objects/{type}) con los scopes de objeto estándar de
// UNIVERSAL_REQUIRED — igual que meetings, que ya funcionaba sin scope propio.
// Ver INVALID_HUBSPOT_SCOPES abajo. Incidente: TER-613.
const JUSTIFIED = new Set([
  ...UNIVERSAL_REQUIRED, // contacts/companies/deals CRUD + owners — engagements/meetings/pipelines/associations usan estos mismos scopes (sin scope granular propio)
  'tickets', // tickets CRUD + ticket pipelines
  'crm.lists.read',
  'crm.lists.write', // lists (v3)
  'conversations.read',
  'conversations.write', // conversations inbox
]);

// Scopes que HubSpot NO reconoce para una public app de marketplace (granular
// por tipo de engagement). Pedirlos rompe `hs project upload` con "scope could
// not be recognized". Lista negativa para impedir la reintroducción. TER-613.
const INVALID_HUBSPOT_SCOPES = [
  'crm.objects.notes.read',
  'crm.objects.notes.write',
  'crm.objects.tasks.read',
  'crm.objects.tasks.write',
  'crm.objects.emails.read',
  'crm.objects.emails.write',
  'crm.objects.calls.read',
  'crm.objects.calls.write',
  'crm.objects.meetings.read',
  'crm.objects.meetings.write',
];

// Hubs / scopes que el MCA NO usa (sus tools no los tocan) o están deprecados.
// Pedirlos era la raíz del fallo en portales sin esos productos.
const FORBIDDEN = [
  /^cms\./,
  /^marketing/,
  /^social$/,
  /^hubdb$/,
  /^business-intelligence$/,
  /^e-commerce$/,
  /^accounting$/,
  /^content$/,
  /^automation/,
  /^files/,
  /^forms/,
  /^settings\./,
  /^sales-email/,
  /^communication_preferences/,
  /^account-info/,
  /^analytics/,
  /^behavioral_events/,
  /^collector\./,
  /^ctas\./,
  /^data_integration/,
  /^external_integrations/,
  /^integration/,
  /^media_bridge/,
  /^record_images/,
  /^scheduler\./,
  /^tax_rates/,
  /^timeline$/,
  /^transactional-email$/,
  /^crm\.export$/,
  /^crm\.import$/,
  /^crm\.dealsplits/,
  /^crm\.schemas\./,
  /\.custom\./,
  /\.sensitive\./,
  /\.highly_sensitive\./,
  /^contacts$/, // legacy monolítico (en sunset)
];

describe('mca.hubspot OAuth scopes — mínimo privilegio', () => {
  it('oauth es required (scope base del flujo)', () => {
    expect(required).toContain('oauth');
  });

  it('cada scope (required + optional) está justificado por una tool', () => {
    const unjustified = all.filter((s) => !JUSTIFIED.has(s));
    expect(unjustified).toEqual([]);
  });

  it('ningún scope de un hub que el MCA no usa ni deprecado', () => {
    const offenders = all.filter((s) => FORBIDDEN.some((re) => re.test(s)));
    expect(offenders).toEqual([]);
  });

  it('no pide scopes de engagement granular (HubSpot no los reconoce — TER-613)', () => {
    const offenders = all.filter((s) => INVALID_HUBSPOT_SCOPES.includes(s));
    expect(offenders).toEqual([]);
  });

  it('manifest y Teros-hsmeta declaran los MISMOS scopes (sync estructural — TER-613)', () => {
    // Dos contratos paralelos: manifest.json lo lee el backend de Teros para el
    // OAuth en runtime; Teros-hsmeta.json lo sube `hs project upload` al portal.
    // Si divergen, el OAuth real y la app del portal se desalinean → falla en
    // runtime o en deploy. El guard de arriba solo mira el manifest; este test
    // hace imposible por construcción que el hsmeta quede desincronizado.
    expect(new Set(hsmeta.config.auth.requiredScopes)).toEqual(new Set(required));
    expect(new Set(hsmeta.config.auth.optionalScopes)).toEqual(new Set(optional));
  });

  it('required = SOLO el núcleo universal (no rompe portales Free)', () => {
    expect(new Set(required)).toEqual(new Set(UNIVERSAL_REQUIRED));
  });

  it('todo lo dependiente de portal va en optional (HubSpot lo auto-omite)', () => {
    // tickets / lists / conversations no son universales → optional.
    for (const s of ['tickets', 'crm.lists.read', 'crm.lists.write', 'conversations.read', 'conversations.write']) {
      expect(optional).toContain(s);
      expect(required).not.toContain(s);
    }
  });

  it('sin duplicados ni solapamiento required/optional', () => {
    expect(new Set(all).size).toBe(all.length);
    expect(required.filter((s) => optional.includes(s))).toEqual([]);
  });

  it('el set total es pequeño (no los ~160 de todos los hubs)', () => {
    expect(all.length).toBeLessThanOrEqual(25);
  });
});
