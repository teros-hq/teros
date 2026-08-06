import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const PROJECT_ROOT = resolve(import.meta.dir, '../../../..');
export const MCAS_ROOT = join(PROJECT_ROOT, 'mcas');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const HEALTH_CHECK_SUFFIXES = ['-health-check', '_health_check', 'health-check'];

export const READ_PREFIXES = ['get-', 'list-', 'search-', 'fetch-', 'read-', 'query-', 'find-'];
export const DESTRUCTIVE_PREFIXES = ['delete-', 'remove-', 'archive-', 'purge-', 'uninstall-'];

// ─── Discovery ───────────────────────────────────────────────────────────────

let _mcaDirsCache: string[] | null = null;

export function discoverMcaDirs(): string[] {
  if (_mcaDirsCache) return _mcaDirsCache;

  const filterMca = process.env.MCA_ID;
  if (filterMca) {
    _mcaDirsCache = [filterMca];
    return _mcaDirsCache;
  }

  const entries = readdirSync(MCAS_ROOT, { withFileTypes: true });
  _mcaDirsCache = entries
    .filter((e) => e.isDirectory() && e.name.startsWith('mca.'))
    .map((e) => e.name)
    .sort();
  return _mcaDirsCache;
}

// ─── File Loaders (cached) ───────────────────────────────────────────────────

const manifestCache = new Map<string, any>();
const packageCache = new Map<string, any>();
const toolsCache = new Map<string, any>();
const entrySourceCache = new Map<string, string | null>();
const allSourceCache = new Map<string, Map<string, string>>();

export function loadManifest(mcaDir: string): any | null {
  if (manifestCache.has(mcaDir)) return manifestCache.get(mcaDir);
  const p = join(MCAS_ROOT, mcaDir, 'manifest.json');
  try {
    const data = JSON.parse(readFileSync(p, 'utf-8'));
    manifestCache.set(mcaDir, data);
    return data;
  } catch {
    manifestCache.set(mcaDir, null);
    return null;
  }
}

export function loadPackageJson(mcaDir: string): any | null {
  if (packageCache.has(mcaDir)) return packageCache.get(mcaDir);
  const p = join(MCAS_ROOT, mcaDir, 'package.json');
  try {
    const data = JSON.parse(readFileSync(p, 'utf-8'));
    packageCache.set(mcaDir, data);
    return data;
  } catch {
    packageCache.set(mcaDir, null);
    return null;
  }
}

export function loadToolsJson(mcaDir: string): any | null {
  if (toolsCache.has(mcaDir)) return toolsCache.get(mcaDir);
  const p = join(MCAS_ROOT, mcaDir, 'tools.json');
  try {
    const data = JSON.parse(readFileSync(p, 'utf-8'));
    toolsCache.set(mcaDir, data);
    return data;
  } catch {
    toolsCache.set(mcaDir, null);
    return null;
  }
}

export function readEntrySource(mcaDir: string): string | null {
  if (entrySourceCache.has(mcaDir)) return entrySourceCache.get(mcaDir)!;
  const manifest = loadManifest(mcaDir);
  if (!manifest?.entrypoint) {
    entrySourceCache.set(mcaDir, null);
    return null;
  }
  const entrypoint = manifest.entrypoint.replace(/^\.\//, '');
  const p = join(MCAS_ROOT, mcaDir, entrypoint);
  try {
    const src = readFileSync(p, 'utf-8');
    entrySourceCache.set(mcaDir, src);
    return src;
  } catch {
    entrySourceCache.set(mcaDir, null);
    return null;
  }
}

export function readAllSourceFiles(mcaDir: string): Map<string, string> {
  if (allSourceCache.has(mcaDir)) return allSourceCache.get(mcaDir)!;
  const result = new Map<string, string>();
  const base = join(MCAS_ROOT, mcaDir);

  function walk(dir: string) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        try {
          result.set(full.slice(base.length + 1), readFileSync(full, 'utf-8'));
        } catch {}
      }
    }
  }

  walk(join(base, 'src'));
  walk(join(base, 'mcp'));

  allSourceCache.set(mcaDir, result);
  return result;
}

// ─── Icon Helpers ────────────────────────────────────────────────────────────

export function resolveIconPath(mcaDir: string, manifest: any): string | null {
  if (!manifest?.icon) return null;
  if (manifest.icon.startsWith('http')) return null;
  const candidates = [
    join(MCAS_ROOT, mcaDir, 'static', manifest.icon),
    join(MCAS_ROOT, mcaDir, manifest.icon),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

export function isPng(filePath: string): boolean {
  try {
    const fd = readFileSync(filePath);
    if (fd.length < 8) return false;
    return fd.subarray(0, 8).equals(PNG_MAGIC);
  } catch {
    return false;
  }
}

export function iconFileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

// ─── Tool Helpers ────────────────────────────────────────────────────────────

export interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, any>;
    required?: string[];
  };
  annotations?: Record<string, any>;
}

export function getTools(mcaDir: string): ToolDef[] {
  const tj = loadToolsJson(mcaDir);
  return tj?.tools ?? [];
}

export function isHealthCheckTool(toolName: string): boolean {
  return HEALTH_CHECK_SUFFIXES.some((s) => toolName === s || toolName.endsWith(s));
}

export function isReadTool(toolName: string): boolean {
  return READ_PREFIXES.some((p) => toolName.startsWith(p));
}

export function isListTool(toolName: string): boolean {
  return toolName.startsWith('list-');
}

export function isDestructiveTool(toolName: string): boolean {
  return DESTRUCTIVE_PREFIXES.some((p) => toolName.startsWith(p));
}
