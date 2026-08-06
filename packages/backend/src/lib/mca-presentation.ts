/**
 * MCA presentation helpers (TER-538).
 *
 * Pure derivations of *catalog presentation* data that used to live in the
 * frontend at render time. They are computed once during `sync-mcas` and
 * materialised in `mca_catalog`, so the client just renders the result.
 *
 * Kept as a separate, dependency-light module so each piece is unit-testable
 * in isolation (see tests/unit/mca-presentation.test.ts).
 */

import type { PNG } from 'pngjs';

// ─── Accent colours (hero gradient) ─────────────────────────────────────────

interface ColorBucket {
  r: number;
  g: number;
  b: number;
  weight: number;
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Extract up to `max` dominant, *saturated*, diverse brand colours from a
 * decoded icon PNG — the palette the hero gradient is built from on the client.
 *
 * Strategy (same pixel-walk idiom as computePixelVariance): sample the RGBA
 * buffer, drop transparent / near-white / near-black / greyish pixels, bucket
 * the rest, weight by saturation, then pick the strongest buckets that aren't
 * near-duplicates of one already chosen. A monochrome logo (black/white)
 * yields 0-1 colour, and the client falls back to the accent.
 */
export function extractAccentColors(png: PNG, max = 3): string[] {
  const { data, width, height } = png;
  const total = width * height;
  if (total === 0) return [];
  const step = Math.max(1, Math.floor(total / 4096)); // ~4k samples regardless of size
  const buckets = new Map<number, ColorBucket>();

  for (let i = 0; i < total; i += step) {
    const o = i * 4;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    const a = data[o + 3];
    if (a < 128) continue; // transparent
    const hi = Math.max(r, g, b);
    const lo = Math.min(r, g, b);
    const lum = (hi + lo) / 2;
    if (lum > 240 || lum < 16) continue; // near-white / near-black
    const sat = hi === 0 ? 0 : (hi - lo) / hi;
    if (sat < 0.18) continue; // greyish — no brand signal

    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4); // 12-bit bucket
    let bk = buckets.get(key);
    if (!bk) {
      bk = { r: 0, g: 0, b: 0, weight: 0 };
      buckets.set(key, bk);
    }
    bk.r += r * sat;
    bk.g += g * sat;
    bk.b += b * sat;
    bk.weight += sat;
  }

  const ranked = [...buckets.values()]
    .filter((bk) => bk.weight > 0)
    .map((bk) => ({
      r: Math.round(bk.r / bk.weight),
      g: Math.round(bk.g / bk.weight),
      b: Math.round(bk.b / bk.weight),
      weight: bk.weight,
    }))
    .sort((a, b) => b.weight - a.weight);

  const picked: Array<{ r: number; g: number; b: number }> = [];
  for (const c of ranked) {
    if (picked.length >= max) break;
    // Skip colours too close (Manhattan distance) to one already picked.
    if (picked.some((p) => Math.abs(p.r - c.r) + Math.abs(p.g - c.g) + Math.abs(p.b - c.b) < 60)) continue;
    picked.push(c);
  }
  return picked.map((c) => toHex(c.r, c.g, c.b));
}

// ─── Tool groups ────────────────────────────────────────────────────────────

// Verbs stripped when deriving a tool's domain group from its name.
const TOOL_VERBS = new Set([
  'get', 'list', 'create', 'update', 'delete', 'set', 'add', 'remove', 'query', 'send',
  'reply', 'mark', 'replace', 'archive', 'search', 'fetch', 'move', 'duplicate', 'export',
  'download', 'upload', 'run', 'execute', 'cancel', 'retry', 'star', 'unstar', 'read', 'write',
  'find', 'make', 'edit', 'open', 'close', 'enable', 'disable', 'check',
]);

/** Domain group derived from a tool name: first non-verb segment, pluralised. */
export function toolGroup(name: string): string {
  const parts = name.replace(/^-+/, '').split('-').filter(Boolean);
  const noun = parts.find((p) => !TOOL_VERBS.has(p.toLowerCase()));
  if (!noun) return 'Other';
  const cap = noun.charAt(0).toUpperCase() + noun.slice(1);
  return /(s|x|ch|sh)$/i.test(cap) ? `${cap}es` : `${cap}s`;
}

// ─── Human tool description ─────────────────────────────────────────────────

/**
 * Tool descriptions in tools.json are written for the agent (they append
 * return-shape and parameter jargon: "… Returns curated { … }. Params: …").
 * The catalog shows them to a human, so keep only the readable lead-in.
 */
export function humanizeToolDescription(desc?: string): string {
  if (!desc) return '';
  const idx = desc.search(/\s(?:Returns\b|Returns:|Params?\b|Params:|Pass\b|Modes:|Not retryable|Idempotent\b)/);
  const lead = (idx > 0 ? desc.slice(0, idx) : desc).trim();
  if (!lead) return '';
  return /[.!?]$/.test(lead) ? lead : `${lead}.`;
}

// ─── Runtime permissions ────────────────────────────────────────────────────

/**
 * Runtime permissions an installed instance actually has — derived from the
 * real execution model, not invented per-MCA: every workspace app mounts the
 * workspace volume read/write, and HTTP-transport MCAs make outbound calls.
 */
export function derivePermissions(
  runtime: { transport?: string } | null | undefined,
): Array<{ type: string; label: string; detail: string }> {
  const out: Array<{ type: string; label: string; detail: string }> = [];
  if (runtime?.transport === 'http') {
    out.push({ type: 'network', label: 'Network', detail: 'Outbound HTTP' });
  }
  out.push({ type: 'filesystem', label: 'Filesystem', detail: 'Read/write' });
  return out;
}
