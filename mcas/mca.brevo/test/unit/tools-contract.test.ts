import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { EMAIL_EVENT_TYPES } from '../../src/tools/_helpers';
import { CAMPAIGN_STATUSES } from '../../src/tools/list-email-campaigns';

/**
 * tools.json ↔ source invariants (lint-as-test).
 *
 *  - M1: the campaign-status FILTER enum is camelCase `inProcess` (the real
 *    Brevo query-param value) and stays in sync between the handler constant
 *    and tools.json — the LLM reads tools.json, the handler validates against
 *    the constant; drift silently breaks the filter.
 *  - M2: permission annotations live in tools.json because the backend gate
 *    reads ONLY this file. A missing `irreversible` on send-transactional-email
 *    would let a grouped "Allow all" send mail with no per-action approval.
 */

interface ToolEntry {
  name: string;
  description: string;
  inputSchema?: {
    properties?: Record<string, { enum?: string[] }>;
    required?: string[];
  };
  annotations?: Record<string, unknown>;
}

const toolsJson = JSON.parse(
  readFileSync(new URL('../../tools.json', import.meta.url), 'utf8'),
) as { tools: ToolEntry[] };

function tool(name: string): ToolEntry {
  const t = toolsJson.tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool "${name}" missing from tools.json`);
  return t;
}

/** Keys accepted by McaToolAnnotationsSchema (packages/shared/src/mca-protocol.ts). */
const ALLOWED_ANNOTATION_KEYS = new Set([
  'version',
  'stability',
  'deprecationMessage',
  'irreversible',
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
]);

describe('M1 — campaign status filter enum (camelCase, SDK-verified)', () => {
  it('uses camelCase `inProcess`, never snake_case `in_process`', () => {
    expect(CAMPAIGN_STATUSES).toContain('inProcess');
    expect(CAMPAIGN_STATUSES).not.toContain('in_process');
  });

  it('is exactly the 6 values from the official Brevo SDK union (getbrevo/brevo-node)', () => {
    // getEmailCampaigns: 'suspended' | 'archive' | 'sent' | 'queued' | 'draft' | 'inProcess'
    const actual: string[] = [...CAMPAIGN_STATUSES].sort();
    expect(actual).toEqual(['archive', 'draft', 'inProcess', 'queued', 'sent', 'suspended']);
  });

  it('tools.json enum is byte-identical to the handler constant (no drift)', () => {
    const enumValues = tool('list-email-campaigns').inputSchema?.properties?.status?.enum;
    expect(enumValues).toEqual([...CAMPAIGN_STATUSES]);
  });

  it('no surface of list-email-campaigns leaks snake_case `in_process`', () => {
    const t = tool('list-email-campaigns');
    expect(JSON.stringify(t)).not.toContain('in_process');
    expect(t.description).toContain('inProcess');
  });
});

describe('M2 — permission annotations (the gate reads ONLY tools.json)', () => {
  it('send-transactional-email is irreversible + destructive → excluded from grouped "Allow all"', () => {
    const a = tool('send-transactional-email').annotations ?? {};
    expect(a.irreversible).toBe(true);
    expect(a.destructiveHint).toBe(true);
    expect(a.openWorldHint).toBe(true);
    // Must NOT be read-only — otherwise the auto-allow policy would skip
    // approval. A writer declares `readOnlyHint: false` explicitly (clearer than
    // omitting); the dangerous value to guard against is `true`, not `false`.
    expect(a.readOnlyHint).not.toBe(true);
  });

  it('read-only listers are annotated readOnlyHint (auto-allow eligible)', () => {
    expect(tool('list-contacts').annotations?.readOnlyHint).toBe(true);
    expect(tool('list-email-campaigns').annotations?.readOnlyHint).toBe(true);
  });

  it('create-contact reaches the network (openWorldHint) and is NOT read-only / irreversible', () => {
    const a = tool('create-contact').annotations ?? {};
    expect(a.openWorldHint).toBe(true);
    expect(a.readOnlyHint).not.toBe(true);
    expect(a.irreversible).toBeUndefined();
  });

  it('every annotation key is valid — a typo makes loadStaticTools reject the WHOLE tools.json', () => {
    for (const t of toolsJson.tools) {
      for (const key of Object.keys(t.annotations ?? {})) {
        expect({ tool: t.name, key, valid: ALLOWED_ANNOTATION_KEYS.has(key) }).toEqual({
          tool: t.name,
          key,
          valid: true,
        });
      }
    }
  });
});

describe('M3 — lists & templates surface (TER — Brevo lists/templates)', () => {
  it('read-only listers are annotated readOnlyHint (auto-allow eligible)', () => {
    expect(tool('list-folders').annotations?.readOnlyHint).toBe(true);
    expect(tool('list-lists').annotations?.readOnlyHint).toBe(true);
    expect(tool('list-email-templates').annotations?.readOnlyHint).toBe(true);
  });

  it('create-list / create-email-template reach the network and are NOT read-only / irreversible', () => {
    for (const name of ['create-list', 'create-email-template']) {
      const a = tool(name).annotations ?? {};
      expect(a.openWorldHint).toBe(true);
      expect(a.readOnlyHint).not.toBe(true);
      // Creating a list/template is reversible (can be deleted) — must NOT carry
      // the irreversible/destructive flags reserved for send-transactional-email.
      expect(a.irreversible).toBeUndefined();
      expect(a.destructiveHint).toBeUndefined();
    }
  });

  it('create-list requires name + folderId (a list cannot exist outside a folder)', () => {
    const req = tool('create-list').inputSchema?.required ?? [];
    expect([...req].sort()).toEqual(['folderId', 'name']);
  });

  it('create-email-template uses the REST field `templateName`, never the SDK-example `name`', () => {
    const t = tool('create-email-template');
    const req = t.inputSchema?.required ?? [];
    expect([...req].sort()).toEqual(['sender', 'subject', 'templateName']);
    // Guard the classic trap: getbrevo/brevo-node's example object shows `name`,
    // but the REST body field is `templateName`. Shipping `name` → Brevo 400.
    expect(t.inputSchema?.properties?.templateName).toBeDefined();
    expect(t.inputSchema?.properties?.name).toBeUndefined();
  });
});

describe('M4 — email campaigns surface', () => {
  it('get-email-campaign is read-only (auto-allow eligible)', () => {
    expect(tool('get-email-campaign').annotations?.readOnlyHint).toBe(true);
  });

  it('create-email-campaign is a reversible writer (draft) — NOT read-only / irreversible', () => {
    const a = tool('create-email-campaign').annotations ?? {};
    expect(a.openWorldHint).toBe(true);
    expect(a.readOnlyHint).not.toBe(true);
    expect(a.irreversible).toBeUndefined();
    expect(a.destructiveHint).toBeUndefined();
  });

  it('send-email-campaign & send-test-email put mail on the wire → irreversible + destructive', () => {
    // Both deliver real email with no undo — must be excluded from grouped
    // "Allow all" via `irreversible: true` (which lives only in tools.json).
    for (const name of ['send-email-campaign', 'send-test-email']) {
      const a = tool(name).annotations ?? {};
      expect(a.irreversible).toBe(true);
      expect(a.destructiveHint).toBe(true);
      expect(a.openWorldHint).toBe(true);
      expect(a.readOnlyHint).not.toBe(true);
    }
  });

  it('create-email-campaign requires name + subject + sender', () => {
    const req = tool('create-email-campaign').inputSchema?.required ?? [];
    expect([...req].sort()).toEqual(['name', 'sender', 'subject']);
  });
});

describe('M5 — contact CRUD surface', () => {
  it('get-contact is read-only (auto-allow eligible)', () => {
    expect(tool('get-contact').annotations?.readOnlyHint).toBe(true);
  });

  it('delete-contact is irreversible + destructive (excluded from grouped "Allow all")', () => {
    const a = tool('delete-contact').annotations ?? {};
    expect(a.irreversible).toBe(true);
    expect(a.destructiveHint).toBe(true);
    expect(a.openWorldHint).toBe(true);
    expect(a.readOnlyHint).not.toBe(true);
  });

  it('update-contact & membership tools are reversible writers — NOT irreversible/destructive', () => {
    for (const name of ['update-contact', 'add-contact-to-list', 'remove-contact-from-list']) {
      const a = tool(name).annotations ?? {};
      expect(a.openWorldHint).toBe(true);
      expect(a.readOnlyHint).not.toBe(true);
      expect(a.irreversible).toBeUndefined();
      expect(a.destructiveHint).toBeUndefined();
    }
  });

  it('membership tools require listId', () => {
    for (const name of ['add-contact-to-list', 'remove-contact-from-list']) {
      expect(tool(name).inputSchema?.required).toEqual(['listId']);
    }
  });
});

describe('M6 — contacts completion surface (import + attributes + segments)', () => {
  it('read-only discovery tools are annotated readOnlyHint (auto-allow eligible)', () => {
    expect(tool('list-attributes').annotations?.readOnlyHint).toBe(true);
    expect(tool('list-segments').annotations?.readOnlyHint).toBe(true);
  });

  it('import-contacts is a reversible writer — NOT read-only / irreversible / destructive', () => {
    const a = tool('import-contacts').annotations ?? {};
    expect(a.openWorldHint).toBe(true);
    expect(a.readOnlyHint).not.toBe(true);
    // Importing contacts can be undone (delete-contact) and sends no email, so
    // it must NOT carry the irreversible/destructive flags reserved for sends.
    expect(a.irreversible).toBeUndefined();
    expect(a.destructiveHint).toBeUndefined();
  });

  it('import-contacts requires listIds (a target list is mandatory)', () => {
    expect(tool('import-contacts').inputSchema?.required).toEqual(['listIds']);
  });

  it('list-attributes takes no params (full set, no pagination)', () => {
    const props = tool('list-attributes').inputSchema?.properties ?? {};
    expect(Object.keys(props)).toEqual([]);
  });
});

describe('M7 — SMTP statistics reports surface', () => {
  it('both reports are read-only (auto-allow eligible, no writes)', () => {
    expect(tool('get-email-event-report').annotations?.readOnlyHint).toBe(true);
    expect(tool('get-aggregated-smtp-report').annotations?.readOnlyHint).toBe(true);
  });

  it('neither report has required params (all filters optional)', () => {
    expect(tool('get-email-event-report').inputSchema?.required).toBeUndefined();
    expect(tool('get-aggregated-smtp-report').inputSchema?.required).toBeUndefined();
  });

  it('the event filter enum in tools.json is byte-identical to EMAIL_EVENT_TYPES (no drift)', () => {
    const enumValues = tool('get-email-event-report').inputSchema?.properties?.event?.enum;
    expect(enumValues).toEqual([...EMAIL_EVENT_TYPES]);
  });

  it('is exactly the 14 event types from the official Brevo SDK (getbrevo/brevo-node)', () => {
    const actual: string[] = [...EMAIL_EVENT_TYPES].sort();
    expect(actual).toEqual([
      'blocked',
      'bounces',
      'clicks',
      'deferred',
      'delivered',
      'error',
      'hardBounces',
      'invalid',
      'loadedByProxy',
      'opened',
      'requests',
      'softBounces',
      'spam',
      'unsubscribed',
    ]);
  });
});
