/**
 * Structural invariant (lint-as-test) — TER-510.
 *
 * Authorization in the WsRouter is per-handler: the router only runs
 * `loggingMiddleware`, so each domain handler is responsible for its own
 * authz. The recurring, high-blast-radius bug class (5 confirmed instances:
 * file-share/terminal TER-480, skill TER-481, project TER-509, agent/app
 * TER-513) is a handler that operates on a resource by id WITHOUT checking
 * who the caller is.
 *
 * The CLAUDE.md rule is explicit: make the error impossible by construction
 * (a build-failing invariant) instead of relying on human discipline. This
 * test encodes the cheapest, lowest-false-positive structural signal for that
 * class: **a handler that discards its context parameter (`_ctx`)**. If a
 * handler doesn't even look at the caller, it cannot be doing authz.
 *
 * SCOPE / HONEST LIMITATION: this guard catches the strongest, unambiguous
 * smell (context fully discarded). It does NOT catch handlers that take `ctx`
 * but fail to verify workspace/agent access while using `ctx.userId` for
 * something else (e.g. project/create before TER-509) — those are covered
 * case-by-case by the per-domain authz tests (TER-468/480/481/509/513). This
 * is the guard against the NEXT instance, not a replacement for those.
 *
 * Two allowlists, both kept honest by an anti-stale check (every allowlisted
 * entry must still discard `_ctx` today — when a fix lands and the handler
 * starts taking `ctx`, the entry MUST be removed or the test goes red):
 *   - PUBLIC:  genuinely identity-free (global catalogue / pure compute).
 *   - DEBT:    real authz holes whose fix lives in an open PR (annotated).
 *              Remove the entry when that PR merges to dev.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const DOMAINS_DIR = resolve(
  __dirname,
  '../../../packages/backend/src/handlers/domains',
);
const BACKEND_SRC = resolve(__dirname, '../../../packages/backend/src');

// ---------------------------------------------------------------------------
// Invariant 1 — no domain handler may discard `_ctx` unless allowlisted
// ---------------------------------------------------------------------------

/** Handlers that legitimately need no caller identity. Permanent. */
const PUBLIC_ALLOWLIST = new Set<string>([
  // agent/list-cores was a public catalogue until TER-412 internalized agent
  // cores → it now takes `ctx` + requireSystemAdmin (admin-only), so it left
  // REALITY and the entry was removed (anti-stale check forced this).
  'provider/list-models.ts::listModels', // global catalogue of active models
  'scheduler/handlers.ts::createParseTimeHandler', // pure time parsing, no DB
  'billing/list-plans.ts::listPlans', // public plan catalogue (isPublic rows only, read-only)
  // capability-token authz, not identity: formRequestId is a server-generated
  // crypto.randomUUID() delivered only to the form's channel; possession is the
  // authorization (same pattern as app/tool-permission-response). Server-side
  // validation + idempotent resolution live in FormManager.handleResponse.
  'app/form-response.ts::formResponse',
]);

/**
 * Known authz debt — real holes whose fix is in an open PR. DELETE the entry
 * when its PR merges to dev (the anti-stale check below forces it: once the
 * handler takes `ctx` + a gate, it leaves REALITY and a stale entry goes red).
 */
const DEBT_ALLOWLIST = new Set<string>([
  // Vacío en este release: project (#210/TER-509), agent.*/app.* (#211/TER-513) y
  // terminal (#172/TER-480) ya toman `ctx` + gate al integrar sus fixes a este lote.
  // Nueva deuda de authz cuyo fix viva en un PR abierto se añade aquí (y se borra al mergear).
]);

/** Files that are not handler modules. `index.ts` is NOT excluded: some
 *  domains (terminal, file-share) register their handlers inline there, and
 *  barrel index files carry no `_ctx` so they add nothing. */
const NON_HANDLER = (rel: string): boolean => {
  const base = rel.split('/').pop() ?? rel;
  return base === 'store.ts' || base.startsWith('_') || base.endsWith('.test.ts');
};

function domainFiles(): string[] {
  return readdirSync(DOMAINS_DIR, { recursive: true })
    .map((p) => String(p).split(sep).join('/'))
    .filter((p) => p.endsWith('.ts') && !NON_HANDLER(p));
}

/**
 * Every line declaring `_ctx` as a handler parameter, identified as
 * `<relpath>::<name>`. Covers the three handler shapes in the codebase:
 *   - `return async function NAME(_ctx, …)`        → NAME
 *   - `router.register('x.y', async (_ctx, …) =>`  → x.y
 *   - `return async (_ctx, …) =>` (factory arrow)  → enclosing createXHandler
 */
function discardedCtxHandlers(src: string, rel: string): string[] {
  const lines = src.split('\n');
  const ids: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/[(,]\s*_ctx\s*:/.test(line)) continue;
    let name =
      line.match(/function\s+(\w+)\s*\(/)?.[1] ??
      line.match(/register\(\s*['"]([\w.]+)['"]/)?.[1] ??
      null;
    if (!name) {
      // factory arrow — walk up to the enclosing `export function createX(`
      for (let j = i; j >= 0 && j > i - 20; j--) {
        const m = lines[j].match(/export function\s+(\w+)\s*\(/);
        if (m) {
          name = m[1];
          break;
        }
      }
    }
    ids.push(`${rel}::${name ?? '<anonymous>'}`);
  }
  return ids;
}

describe('domain handler authz: no discarded `_ctx` (TER-510)', () => {
  const files = domainFiles();
  const reality = new Set<string>();
  for (const rel of files) {
    for (const id of discardedCtxHandlers(readFileSync(resolve(DOMAINS_DIR, rel), 'utf-8'), rel)) {
      reality.add(id);
    }
  }
  const allowed = new Set<string>([...PUBLIC_ALLOWLIST, ...DEBT_ALLOWLIST]);

  it('no un-allowlisted handler discards its context (new authz holes)', () => {
    // A handler appears here when it takes `_ctx` and is neither a documented
    // public endpoint nor tracked debt → classify it (public) or fix it (gate).
    const unexplained = [...reality].filter((id) => !allowed.has(id)).sort();
    expect(unexplained).toEqual([]);
  });

  it('every allowlist entry still discards `_ctx` (anti-stale: clean up after a fix lands)', () => {
    // When a DEBT fix merges (handler now takes `ctx` + a gate), it leaves
    // REALITY → its stale entry must be deleted. This forces the cleanup.
    const stale = [...allowed].filter((id) => !reality.has(id)).sort();
    expect(stale).toEqual([]);
  });

  it('the scan actually parsed handlers (anti-NO-OP)', () => {
    // Guards against a refactor that changes the handler shape and makes the
    // checks above pass vacuously.
    expect(files.length).toBeGreaterThan(100);
    expect(reality.size).toBeGreaterThanOrEqual(allowed.size);
  });
});

// ---------------------------------------------------------------------------
// Invariant 2 — every late-bound setWorkspaceService declarer is wired in
// server-bootstrap (TER-511 hallazgo: a declarer left unwired degrades
// silently to the original cross-workspace bug — fail-open, violates Fail Fast)
// ---------------------------------------------------------------------------

/** Services whose `setWorkspaceService` is propagated by another service's
 *  setWorkspaceService rather than wired directly in bootstrap. Each key MUST
 *  be a real declarer (checked below). */
const TRANSITIVE_WIRING = new Map<string, string>([
  ['user', 'auth-service.setWorkspaceService() calls userService.setWorkspaceService()'],
]);

/** norm('mca-service') === norm('mcaService') === 'mca' */
const norm = (s: string): string =>
  s.toLowerCase().replace(/[-_]/g, '').replace(/service$/, '');

function declarerBasenames(): string[] {
  const dirs = ['services', 'auth'];
  const out: string[] = [];
  for (const dir of dirs) {
    const root = resolve(BACKEND_SRC, dir);
    for (const p of readdirSync(root, { recursive: true })) {
      const rel = String(p);
      if (!rel.endsWith('.ts') || rel.endsWith('.test.ts')) continue;
      const src = readFileSync(resolve(root, rel), 'utf-8');
      if (/setWorkspaceService\s*\(\s*\w+\s*:\s*WorkspaceService\s*\)\s*:/.test(src)) {
        out.push((rel.split(sep).pop() ?? rel).replace(/\.ts$/, ''));
      }
    }
  }
  return out;
}

function bootstrapWiredVars(): string[] {
  const src = readFileSync(resolve(BACKEND_SRC, 'bootstrap/server-bootstrap.ts'), 'utf-8');
  return src
    .split('\n')
    .filter((line) => !line.trim().startsWith('//')) // a commented-out wire is NOT wired
    .flatMap((line) => [...line.matchAll(/(\w+)\.setWorkspaceService\s*\(/g)].map((m) => m[1]));
}

describe('setWorkspaceService late-bind is fully wired (TER-510 / TER-511)', () => {
  const declarers = declarerBasenames();
  const wiredNorms = new Set(bootstrapWiredVars().map(norm));

  it('every declarer is wired in bootstrap (directly or transitively)', () => {
    const unwired = declarers
      .map(norm)
      .filter((n) => !wiredNorms.has(n) && !TRANSITIVE_WIRING.has(n))
      .sort();
    // A declarer here is a service that late-binds WorkspaceService but never
    // receives it → it silently degrades (the TER-511 / #185 fail-open).
    expect(unwired).toEqual([]);
  });

  it('transitive-wiring allowlist has no dead entries (anti-stale)', () => {
    const declarerNorms = new Set(declarers.map(norm));
    const dead = [...TRANSITIVE_WIRING.keys()].filter((k) => !declarerNorms.has(k)).sort();
    expect(dead).toEqual([]);
  });

  it('found the known declarers (anti-NO-OP)', () => {
    // mca / auth / user / pubsub today; feature-flag joins when #185 lands.
    expect(declarers.length).toBeGreaterThanOrEqual(4);
    expect(wiredNorms.size).toBeGreaterThanOrEqual(3);
  });
});
