#!/usr/bin/env bun
/**
 * Sync mca.teros.remote tool definitions from the teros-remote daemon repo.
 *
 * The daemon is the source of truth for the Teros Remote tool surface
 * (`packages/mca/tools.json` there, generated from its dispatcher by
 * `dump-tools.ts`). This script converts that file into the monorepo's
 * `tools.json` shape (`inputSchema` instead of `parameters`, Teros annotation
 * flags instead of the daemon's `permission` label) and derives `i18n/en.json`
 * from it, so `mcas/mca.teros.remote` stays a generated mirror — never edited
 * by hand. The repos stay separate (spec: "separate repository"), so this is a
 * copy step rather than a symlink; run it after bumping the daemon.
 *
 * Usage:
 *   bun scripts/sync-remote-tools.ts                               # /workspace/teros-remote
 *   TEROS_REMOTE_PATH=/path/to/teros-remote bun scripts/sync-remote-tools.ts
 *   bun scripts/sync-remote-tools.ts --check                       # exit 1 if out of date
 *   bun scripts/sync-remote-tools.ts --force                       # skip the stale-source guard
 *
 * Safety: the script refuses to write when the source daemonVersion is older
 * than the version recorded in the target's `$comment` — that almost always
 * means the source is a stale clone (T-REM-4: a stale `/opt/teros-remote`
 * nearly reverted the MCA from 0.2.0/22 tools to 0.1.0/21 tools). Pass
 * `--force` only if you really mean to downgrade.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface DaemonTool {
  name: string;
  group?: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  annotations?: Record<string, unknown> & { permission?: 'ask' | 'alwaysAsk' | 'allow' };
}

interface DaemonToolsFile {
  daemonVersion: string;
  parity: Record<string, string>;
  errorCodes: string[];
  tools: DaemonTool[];
}

interface MonorepoTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  annotations?: Record<string, unknown>;
}

const ROOT = resolve(import.meta.dir, '..');
// Default source is the team's working clone. `/opt/teros-remote` is a stale
// clone (orphan history, daemon 0.1.0) — do NOT point this back there without
// deleting that clone first (see T-REM-4).
const DEFAULT_REMOTE_PATH = '/workspace/teros-remote';
const remotePath = resolve(process.env.TEROS_REMOTE_PATH ?? DEFAULT_REMOTE_PATH);
const sourcePath = resolve(remotePath, 'packages/mca/tools.json');
const targetDir = resolve(ROOT, 'mcas/mca.teros.remote');
const targetTools = resolve(targetDir, 'tools.json');
const targetI18n = resolve(targetDir, 'i18n/en.json');
const check = process.argv.includes('--check');
const force = process.argv.includes('--force');

if (!existsSync(sourcePath)) {
  console.error(`teros-remote tools.json not found at ${sourcePath} (set TEROS_REMOTE_PATH)`);
  process.exit(1);
}

const source = JSON.parse(readFileSync(sourcePath, 'utf-8')) as DaemonToolsFile;

/** Parse a `x.y.z` semver-ish string into a comparable tuple. Non-numeric parts become 0. */
function parseVersion(v: string): [number, number, number] {
  const m = v.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** Extract `daemon X.Y.Z` from the target's generated `$comment`, if present. */
function currentTargetVersion(): string | null {
  if (!existsSync(targetTools)) return null;
  try {
    const parsed = JSON.parse(readFileSync(targetTools, 'utf-8')) as { $comment?: string };
    const m = parsed.$comment?.match(/daemon\s+(\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Stale-source guard: refuse to silently downgrade the MCA (T-REM-4).
const targetVersion = currentTargetVersion();
if (!force && targetVersion && compareVersions(source.daemonVersion, targetVersion) < 0) {
  console.error(
    `Refusing to sync: source daemonVersion ${source.daemonVersion} is OLDER than the target's ${targetVersion}.\n` +
      `Source: ${sourcePath}\n` +
      `This usually means the source repo is a stale clone. Point TEROS_REMOTE_PATH at the real teros-remote repo,\n` +
      `or pass --force if you genuinely intend to downgrade the MCA.`,
  );
  process.exit(1);
}

/** `permission: 'alwaysAsk'` → `alwaysAsk: true`; `ask` is the Teros default for mutations (dropped). */
function convertAnnotations(a: DaemonTool['annotations']): Record<string, unknown> | undefined {
  if (!a) return undefined;
  const {
    permission,
    group: _group,
    ...rest
  } = a as Record<string, unknown> & { permission?: string; group?: string };
  const out: Record<string, unknown> = { ...rest };
  if (permission === 'alwaysAsk') out.alwaysAsk = true;
  return out;
}

const tools: MonorepoTool[] = source.tools.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.parameters,
  ...(t.annotations
    ? {
        annotations: {
          ...convertAnnotations(t.annotations),
          ...(t.group ? { group: t.group } : {}),
        },
      }
    : {}),
}));

const toolsFile = {
  $schema: 'https://teros.ai/schemas/mca-tools.json',
  $comment: `Generated by scripts/sync-remote-tools.ts from teros-remote packages/mca/tools.json (daemon ${source.daemonVersion}) — do not edit by hand.`,
  mcaId: 'mca.teros.remote',
  parity: source.parity,
  errorCodes: source.errorCodes,
  tools,
};

const i18n = {
  tools: Object.fromEntries(
    source.tools.map((t) => [
      t.name,
      {
        name: t.name,
        description: t.description,
        params: Object.fromEntries(
          Object.entries(t.parameters.properties).map(([k, v]) => [
            k,
            (v as { description?: string }).description ?? '',
          ]),
        ),
      },
    ]),
  ),
  name: 'Teros Remote',
  description:
    'Operate a paired remote machine (bash + filesystem) through an outbound tunnel. Filesystem tools are confined to the roots allowlisted on the machine; bash runs with the daemon user’s full permissions when enabled.',
  changelog: [
    {
      notes:
        'Initial release — pair a machine with teros-remote and operate its files and shell from an agent',
    },
  ],
};

const toolsText = `${JSON.stringify(toolsFile, null, 2)}\n`;
const i18nText = `${JSON.stringify(i18n, null, 2)}\n`;

if (check) {
  const current = existsSync(targetTools) ? readFileSync(targetTools, 'utf-8') : '';
  const currentI18n = existsSync(targetI18n) ? readFileSync(targetI18n, 'utf-8') : '';
  if (current !== toolsText || currentI18n !== i18nText) {
    console.error(
      'mcas/mca.teros.remote is out of date with the daemon — run `bun scripts/sync-remote-tools.ts`',
    );
    process.exit(1);
  }
  console.log(
    `mcas/mca.teros.remote is in sync (${tools.length} tools, daemon ${source.daemonVersion})`,
  );
  process.exit(0);
}

writeFileSync(targetTools, toolsText);
writeFileSync(targetI18n, i18nText);
console.log(`Wrote ${tools.length} tools → ${targetTools} (daemon ${source.daemonVersion})`);
