/**
 * Architectural invariant (lint-as-test): there is exactly ONE place in the
 * backend that builds + inserts an agent document — AgentProvisioningService.
 *
 * This is the structural guarantee behind "migrated ≡ created" and "created ≡
 * created": as long as every creation path funnels through that single service,
 * no path can silently re-introduce a divergent agent shape (the historical
 * bugs were exactly hand-built docs missing `status` / app provisioning).
 *
 * Pure source scan — no Mongo, no runtime. Fails the moment a new handler does
 * `collection('agents').insertOne(...)` on its own.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const BACKEND_SRC = join(REPO_ROOT, 'packages/backend/src');

// The single legitimate insertion site.
const ALLOWLIST = ['services/agent-provisioning-service.ts'];

// Dev/seed/migration code legitimately builds agents outside request handling.
const EXCLUDED_DIR_FRAGMENTS = ['/scripts/', '/migrations/', '/__tests__/'];

// Inline forms: collection('agents').insertOne / .agents.insertOne in one expr.
const INSERT_PATTERNS = [
  /collection<[^>]*>\(\s*['"]agents['"]\s*\)\s*\.\s*(insertOne|insertMany)/,
  /collection\(\s*['"]agents['"]\s*\)\s*\.\s*(insertOne|insertMany)/,
  /\.agents\s*\.\s*(insertOne|insertMany)/,
  /\bagents\s*\.\s*(insertOne|insertMany)/,
];

/**
 * True if the source inserts into the `agents` collection by ANY form, including
 * the 2-line indirection the inline patterns miss:
 *   const c = db.collection('agents'); await c.insertOne(doc)
 * We bind every variable assigned from `collection('agents')` and then look for
 * `<var>.insertOne|insertMany` on it (co-presence in the same file).
 */
function insertsIntoAgents(src: string): boolean {
  if (INSERT_PATTERNS.some((re) => re.test(src))) return true;
  const assignRe =
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\bcollection(?:<[^>]*>)?\(\s*['"]agents['"]\s*\)/g;
  const vars = new Set<string>();
  let m: RegExpExecArray | null = assignRe.exec(src);
  while (m !== null) {
    vars.add(m[1]);
    m = assignRe.exec(src);
  }
  for (const v of vars) {
    if (new RegExp(`\\b${v}\\s*\\.\\s*(?:insertOne|insertMany)\\b`).test(src)) return true;
  }
  return false;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('agent creation has a single insertion path', () => {
  it('only AgentProvisioningService inserts into the agents collection', () => {
    const violators: string[] = [];

    for (const file of walk(BACKEND_SRC)) {
      const rel = file.slice(BACKEND_SRC.length + 1);
      if (ALLOWLIST.includes(rel)) continue;
      if (file.endsWith('.test.ts') || file.endsWith('.spec.ts')) continue;
      const norm = file.replace(/\\/g, '/');
      if (EXCLUDED_DIR_FRAGMENTS.some((frag) => norm.includes(frag))) continue;

      const src = readFileSync(file, 'utf-8');
      if (insertsIntoAgents(src)) {
        violators.push(rel);
      }
    }

    expect(violators).toEqual([]);
  });

  // Guard the guard: the detector must catch the 2-line indirection (and not
  // false-positive on a benign read), or a future handler could slip an insert
  // past the scan via a variable.
  it('detects insertion through an intermediate variable, not just inline', () => {
    expect(insertsIntoAgents("const c = db.collection('agents');\nawait c.insertOne(doc);")).toBe(true);
    expect(insertsIntoAgents("const agentsCol = db.collection('agents')\nagentsCol.insertMany(docs)")).toBe(true);
    // benign: read-only use of the bound variable must NOT trip the guard
    expect(insertsIntoAgents("const c = db.collection('agents');\nconst x = await c.findOne({});")).toBe(false);
    // a different collection must NOT trip it
    expect(insertsIntoAgents("const c = db.collection('agent_cores');\nawait c.insertOne(doc);")).toBe(false);
  });
});
