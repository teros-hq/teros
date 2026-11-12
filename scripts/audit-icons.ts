#!/usr/bin/env tsx
/**
 * Teros Icon Audit Script
 *
 * Audits every MCA for icon compliance against the Teros icon standard:
 *   - icon.svg       → monochrome SVG, 512×512 viewBox, square, uses currentColor
 *   - icon-color.svg → color SVG, 512×512 viewBox, square, has hardcoded colors
 *   - icon.png       → optional color PNG, 512×512, square
 *
 * Usage:
 *   tsx scripts/audit-icons.ts                 # Full report (all MCAs)
 *   tsx scripts/audit-icons.ts --quiet          # Summary only
 *   tsx scripts/audit-icons.ts --json           # JSON output
 *   tsx scripts/audit-icons.ts mca.plaud        # Specific MCA(s)
 *   tsx scripts/audit-icons.ts --help           # Help
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MCAS_PATH = join(__dirname, '..', 'mcas');
const MIN_SIZE = 512;

// ============================================================================
// TYPES
// ============================================================================

interface IconInfo {
  exists: boolean;
  w: number | null;
  h: number | null;
  square: boolean | null;
  minSize: boolean | null;
  compliant: boolean;
  hasCurrentColor?: boolean | null;
  hasColor?: boolean | null;
}

interface AuditResult {
  id: string;
  name: string;
  category: string;
  mono: IconInfo;       // icon.svg
  colorSvg: IconInfo;   // icon-color.svg
  png: IconInfo;        // icon.png
  status: 'FULL' | 'MONO_OK_PNG_OK' | 'MONO_ONLY' | 'COLOR_ONLY' | 'PNG_ONLY' | 'NONE';
}

// ============================================================================
// PNG DIMENSIONS — read width/height from PNG IHDR header
// ============================================================================

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function getPngDimensions(path: string): [number | null, number | null] {
  try {
    const buf = readFileSync(path);
    if (buf.length < 24 || !PNG_MAGIC.every((b, i) => buf[i] === b)) return [null, null];
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    return [w, h];
  } catch {
    return [null, null];
  }
}

// ============================================================================
// SVG VIEWBOX — extract dimensions from viewBox or width/height attrs
// ============================================================================

function getSvgViewBox(path: string): [number | null, number | null] {
  try {
    const content = readFileSync(path, 'utf-8');

    // Try viewBox="x y w h"
    const vbMatch = content.match(/viewBox=["']([^"']+)["']/);
    if (vbMatch) {
      const parts = vbMatch[1].trim().split(/[\s,]+/);
      if (parts.length >= 4) {
        return [parseFloat(parts[2]), parseFloat(parts[3])];
      }
    }

    // Try width="N" height="N"
    const wMatch = content.match(/\bwidth=["'](\d+)/);
    const hMatch = content.match(/\bheight=["'](\d+)/);
    if (wMatch && hMatch) {
      return [parseFloat(wMatch[1]), parseFloat(hMatch[1])];
    }

    return [null, null];
  } catch {
    return [null, null];
  }
}

// ============================================================================
// SVG CONTENT CHECKS
// ============================================================================

function checkCurrentColor(path: string): boolean {
  try {
    return readFileSync(path, 'utf-8').includes('currentColor');
  } catch {
    return false;
  }
}

function checkHasColor(path: string): boolean {
  try {
    const content = readFileSync(path, 'utf-8');
    const colors = content.match(/(?:fill|stroke|stop-color)=["'](#?[a-zA-Z0-9]+)["']/g) ?? [];
    const realColors = colors.filter((c) => {
      const val = c.replace(/(?:fill|stroke|stop-color)=["']/, '').replace(/["']$/, '').toLowerCase();
      return !['currentcolor', 'none', 'white', '#fff', '#ffffff', '#fafafa', 'black', '#000', '#000000', 'transparent'].includes(val);
    });
    return realColors.length > 0;
  } catch {
    return false;
  }
}

// ============================================================================
// MANIFEST READING
// ============================================================================

interface Manifest {
  id?: string;
  name?: string;
  category?: string;
  icon?: string;
}

function readManifest(mcaDir: string): Manifest | null {
  const manifestPath = join(mcaDir, 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch {
    return null;
  }
}

// ============================================================================
// AUDIT SINGLE ICON FILE
// ============================================================================

function auditSvg(path: string, checkType: 'mono' | 'color'): IconInfo {
  const exists = existsSync(path);
  if (!exists) {
    return { exists: false, w: null, h: null, square: null, minSize: null, compliant: false };
  }

  const [w, h] = getSvgViewBox(path);
  const square = w !== null && h !== null && w === h;
  const minSize = w !== null && h !== null && w >= MIN_SIZE && h >= MIN_SIZE;

  let hasCurrentColor: boolean | null = null;
  let hasColor: boolean | null = null;

  if (checkType === 'mono') {
    hasCurrentColor = checkCurrentColor(path);
  } else {
    hasColor = checkHasColor(path);
  }

  const compliant =
    w !== null && h !== null &&
    w >= MIN_SIZE && h >= MIN_SIZE &&
    w === h &&
    (checkType === 'mono' ? hasCurrentColor : hasColor);

  return { exists: true, w, h, square, minSize, compliant, hasCurrentColor, hasColor };
}

function auditPng(path: string): IconInfo {
  const exists = existsSync(path);
  if (!exists) {
    return { exists: false, w: null, h: null, square: null, minSize: null, compliant: false };
  }

  const [w, h] = getPngDimensions(path);
  const square = w !== null && h !== null && w === h;
  const minSize = w !== null && h !== null && w >= MIN_SIZE && h >= MIN_SIZE;
  const compliant = w !== null && h !== null && w >= MIN_SIZE && h >= MIN_SIZE && w === h;

  return { exists: true, w, h, square, minSize, compliant };
}

// ============================================================================
// AUDIT ALL MCAS
// ============================================================================

function auditAll(): AuditResult[] {
  const mcaDirs = readdirSync(MCAS_PATH, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('mca.'))
    .map((e) => e.name)
    .sort();

  const results: AuditResult[] = [];

  for (const mcaDirName of mcaDirs) {
    const mcaDir = join(MCAS_PATH, mcaDirName);
    const manifest = readManifest(mcaDir);
    if (!manifest) continue;

    const staticDir = join(mcaDir, 'static');

    const mono = auditSvg(join(staticDir, 'icon.svg'), 'mono');
    const colorSvg = auditSvg(join(staticDir, 'icon-color.svg'), 'color');
    const png = auditPng(join(staticDir, 'icon.png'));

    const monoOk = mono.compliant;
    const colorOk = colorSvg.compliant;
    const pngOk = png.compliant;

    let status: AuditResult['status'];
    if (monoOk && colorOk) status = 'FULL';
    else if (monoOk && !colorOk && pngOk) status = 'MONO_OK_PNG_OK';
    else if (monoOk && !colorOk) status = 'MONO_ONLY';
    else if (!monoOk && colorOk) status = 'COLOR_ONLY';
    else if (!monoOk && !colorOk && pngOk) status = 'PNG_ONLY';
    else status = 'NONE';

    results.push({
      id: manifest.id ?? mcaDirName,
      name: manifest.name ?? mcaDirName,
      category: manifest.category ?? 'other',
      mono,
      colorSvg,
      png,
      status,
    });
  }

  return results;
}

// ============================================================================
// CLI FORMATTING
// ============================================================================

function fmtIconInfo(info: IconInfo, type: 'mono' | 'color' | 'png'): string {
  if (!info.exists) return 'MISSING';

  const w = info.w ? Math.round(info.w) : '?';
  const h = info.h ? Math.round(info.h) : '?';
  const sq = info.square ? 'sq' : '!sq';
  const ms = info.minSize ? '512+' : '<512';

  let extra = '';
  if (type === 'mono' && info.exists) extra = info.hasCurrentColor ? ' cc' : ' no-cc';
  if (type === 'color' && info.exists) extra = info.hasColor ? ' col' : ' mono?';
  if (type === 'png') extra = ' (opt)';

  const ok = info.compliant ? 'OK' : 'FAIL';
  return `${w}x${h} ${sq} ${ms}${extra} ${ok}`;
}

// ============================================================================
// CLI ENTRY POINT
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Teros Icon Audit

Usage:
  tsx scripts/audit-icons.ts                 # Full report (all MCAs)
  tsx scripts/audit-icons.ts --quiet          # Summary only
  tsx scripts/audit-icons.ts --json           # JSON output
  tsx scripts/audit-icons.ts mca.plaud        # Specific MCA(s)

Checks per MCA:
  - icon.svg       → monochrome, 512x512 viewBox, square, currentColor
  - icon-color.svg → color, 512x512 viewBox, square, hardcoded colors
  - icon.png       → optional, 512x512, square
`);
    process.exit(0);
  }

  const jsonMode = args.includes('--json');
  const quietMode = args.includes('--quiet');
  const filterIds = args.filter((a) => !a.startsWith('--'));

  let results = auditAll();

  if (filterIds.length > 0) {
    results = results.filter((r) => filterIds.includes(r.id));
  }

  if (jsonMode) {
    console.log(JSON.stringify(results, null, 2));
    process.exit(0);
  }

  // Summary
  const total = results.length;
  const monoOk = results.filter((r) => r.mono.compliant).length;
  const colorOk = results.filter((r) => r.colorSvg.compliant).length;
  const pngOk = results.filter((r) => r.png.compliant).length;
  const full = results.filter((r) => r.status === 'FULL').length;
  const none = results.filter((r) => r.status === 'NONE').length;
  const partial = total - full - none;

  console.log(`\n${'='.repeat(80)}`);
  console.log(`TEROS ICON AUDIT — ${total} MCAs`);
  console.log(`${'='.repeat(80)}\n`);

  console.log(`  Monochrome SVG (icon.svg):      ${monoOk}/${total} compliant`);
  console.log(`  Color SVG (icon-color.svg):     ${colorOk}/${total} compliant`);
  console.log(`  Color PNG (icon.png):           ${pngOk}/${total} compliant (optional)`);
  console.log();
  console.log(`  Status breakdown:`);
  console.log(`    FULL (mono + color SVG):      ${full}`);
  console.log(`    MONO_OK + PNG (no color SVG): ${results.filter((r) => r.status === 'MONO_OK_PNG_OK').length}`);
  console.log(`    MONO_ONLY:                    ${results.filter((r) => r.status === 'MONO_ONLY').length}`);
  console.log(`    COLOR_ONLY:                   ${results.filter((r) => r.status === 'COLOR_ONLY').length}`);
  console.log(`    PNG_ONLY:                     ${results.filter((r) => r.status === 'PNG_ONLY').length}`);
  console.log(`    NONE:                         ${none}`);

  if (!quietMode) {
    console.log(`\n${'MCA ID'.padEnd(40)} ${'icon.svg'.padStart(20)} ${'icon-color.svg'.padStart(20)} ${'icon.png'.padStart(16)} Status`);
    console.log('-'.repeat(120));

    for (const r of results) {
      const monoStr = fmtIconInfo(r.mono, 'mono');
      const colorStr = fmtIconInfo(r.colorSvg, 'color');
      const pngStr = fmtIconInfo(r.png, 'png');
      console.log(`${r.id.padEnd(40)} ${monoStr.padStart(20)} ${colorStr.padStart(20)} ${pngStr.padStart(16)} ${r.status}`);
    }
  }

  // Write JSON for canvas consumption
  const jsonPath = join(__dirname, '..', 'icon-audit.json');
  writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  console.log(`\nAudit JSON written to ${jsonPath}`);

  process.exit(none > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
