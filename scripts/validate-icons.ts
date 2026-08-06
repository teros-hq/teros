#!/usr/bin/env bun
/**
 * MCA Icon Validator
 *
 * Validates icon files for all MCAs against the documented standards

 *
 * Rules enforced:
 *   - Icon file referenced in manifest.json must exist
 *   - File must be a valid PNG (checked via PNG header magic bytes)
 *   - Image must be square (width === height)
 *   - Dimensions must be at least 256×256 px
 *   - File size must not exceed 150 KB
 *   - File size must not be suspiciously small (< 5 KB → likely a placeholder)
 *   - Pixel variance must not be near-zero (solid-color placeholder detection)
 *
 * Usage:
 *   bun scripts/validate-icons.ts                    # All MCAs
 *   bun scripts/validate-icons.ts mca.plaud          # Specific MCA
 *   bun scripts/validate-icons.ts --help             # Help
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { PNG } from 'pngjs';

const MCAS_PATH = join(import.meta.dir, '../mcas');

// ============================================================================
// CONSTANTS — from Section 10 of MCA-DEVELOPMENT.md
// ============================================================================

const MIN_DIMENSION = 256; // px — hard minimum
const MAX_FILE_SIZE_BYTES = 150 * 1024; // 150 KB
const MIN_FILE_SIZE_BYTES = 5 * 1024; // < 5 KB → suspiciously small / placeholder
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Variance threshold for solid-color placeholder detection.
// We sample every 4th pixel (RGBA), compute per-channel variance and average it.
// A real icon has at least some variance; a solid fill has 0.
// Threshold of 20 (on a 0–255 scale) catches near-uniform images.
const MIN_VARIANCE_THRESHOLD = 20;

// ============================================================================
// TYPES
// ============================================================================

export interface IconValidationResult {
  mcaId: string;
  iconPath: string | null;
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ============================================================================
// PNG HEADER CHECK (fast, no full decode needed)
// ============================================================================

function isPngBuffer(buf: Buffer): boolean {
  if (buf.length < 8) return false;
  return PNG_MAGIC.every((byte, i) => buf[i] === byte);
}

// ============================================================================
// PIXEL VARIANCE (placeholder detection)
// ============================================================================

/**
 * Compute average per-channel variance over a sample of pixels.
 * We sample every 16th pixel to keep it fast on large images.
 * Returns a number in [0, 65025] — 0 means perfectly uniform.
 */
function computePixelVariance(png: PNG): number {
  const data = png.data; // RGBA, 4 bytes per pixel
  const totalPixels = png.width * png.height;
  const step = 16; // sample every 16th pixel

  // First pass: compute channel means
  let sumR = 0,
    sumG = 0,
    sumB = 0;
  let count = 0;

  for (let i = 0; i < totalPixels; i += step) {
    const offset = i * 4;
    sumR += data[offset];
    sumG += data[offset + 1];
    sumB += data[offset + 2];
    count++;
  }

  if (count === 0) return 0;

  const meanR = sumR / count;
  const meanG = sumG / count;
  const meanB = sumB / count;

  // Second pass: compute variance
  let varR = 0,
    varG = 0,
    varB = 0;

  for (let i = 0; i < totalPixels; i += step) {
    const offset = i * 4;
    varR += (data[offset] - meanR) ** 2;
    varG += (data[offset + 1] - meanG) ** 2;
    varB += (data[offset + 2] - meanB) ** 2;
  }

  const avgVariance = (varR + varG + varB) / (3 * count);
  return avgVariance;
}

// ============================================================================
// ICON VALIDATION CORE
// ============================================================================

/**
 * Validate the icon for a single MCA.
 * @param mcaId  The MCA directory name (e.g. "mca.plaud")
 * @param iconField  The value of the "icon" field in manifest.json
 */
export function validateMcaIcon(mcaId: string, iconField: string): IconValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Resolve icon path — the icon field is relative to the MCA directory
  // (e.g. "icon.png" → mcas/mca.plaud/static/icon.png or mcas/mca.plaud/icon.png)
  // We try static/ first (documented convention), then the MCA root.
  const mcaDir = join(MCAS_PATH, mcaId);
  const candidatePaths = [
    join(mcaDir, 'static', iconField),
    join(mcaDir, iconField),
  ];

  const iconPath = candidatePaths.find((p) => existsSync(p)) ?? null;

  if (!iconPath) {
    return {
      mcaId,
      iconPath: null,
      valid: false,
      errors: [
        `icon file not found: "${iconField}" (tried static/${iconField} and ${iconField})`,
      ],
      warnings,
    };
  }

  // ── 1. File size checks ──────────────────────────────────────────────────

  const stat = statSync(iconPath);
  const fileSizeBytes = stat.size;

  if (fileSizeBytes < MIN_FILE_SIZE_BYTES) {
    errors.push(
      `file too small: ${fileSizeBytes} bytes (< ${MIN_FILE_SIZE_BYTES} bytes) — likely a placeholder`,
    );
  }

  if (fileSizeBytes > MAX_FILE_SIZE_BYTES) {
    errors.push(
      `file too large: ${Math.round(fileSizeBytes / 1024)} KB (max ${MAX_FILE_SIZE_BYTES / 1024} KB)`,
    );
  }

  // ── 2. PNG magic bytes ───────────────────────────────────────────────────

  const buf = readFileSync(iconPath);

  if (!isPngBuffer(buf)) {
    errors.push('not a valid PNG file (wrong magic bytes)');
    // Cannot continue with pixel-level checks
    return { mcaId, iconPath, valid: errors.length === 0, errors, warnings };
  }

  // ── 3. PNG decode for dimension & content checks ─────────────────────────

  let png: PNG;
  try {
    png = PNG.sync.read(buf);
  } catch (err: any) {
    errors.push(`PNG decode failed: ${err.message}`);
    return { mcaId, iconPath, valid: false, errors, warnings };
  }

  const { width, height } = png;

  // Square check
  if (width !== height) {
    errors.push(`not square: ${width}×${height} px — width must equal height`);
  }

  // Minimum dimension check
  const minDim = Math.min(width, height);
  if (minDim < MIN_DIMENSION) {
    errors.push(
      `too small: ${width}×${height} px (minimum ${MIN_DIMENSION}×${MIN_DIMENSION} px)`,
    );
  }

  // Preferred size warning (not an error)
  if (minDim >= MIN_DIMENSION && minDim < 512) {
    warnings.push(
      `size ${width}×${height} px is acceptable but 512×512 or 1024×1024 is preferred`,
    );
  }

  // ── 4. Placeholder detection (solid-color / near-uniform) ────────────────

  // Only run if file is small — large files are very unlikely to be solid fills
  if (fileSizeBytes < MIN_FILE_SIZE_BYTES * 2) {
    const variance = computePixelVariance(png);
    if (variance < MIN_VARIANCE_THRESHOLD) {
      errors.push(
        `appears to be a placeholder: near-uniform pixel content (variance=${variance.toFixed(1)}, threshold=${MIN_VARIANCE_THRESHOLD}) — solid-color fills are not acceptable`,
      );
    }
  }

  return {
    mcaId,
    iconPath,
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ============================================================================
// MANIFEST READING HELPERS
// ============================================================================

function getIconFieldFromManifest(mcaId: string): string | null {
  const manifestPath = join(MCAS_PATH, mcaId, 'manifest.json');
  if (!existsSync(manifestPath)) return null;

  try {
    const data = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    return typeof data.icon === 'string' && data.icon.length > 0 ? data.icon : null;
  } catch {
    return null;
  }
}

function discoverMcas(): string[] {
  return readdirSync(MCAS_PATH, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('mca.'))
    .map((e) => e.name);
}

// ============================================================================
// VALIDATE ONE MCA (reading icon field from manifest)
// ============================================================================

export function validateMcaIconFromManifest(mcaId: string): IconValidationResult {
  const iconField = getIconFieldFromManifest(mcaId);

  if (iconField === null) {
    return {
      mcaId,
      iconPath: null,
      valid: false,
      errors: ['manifest.json missing or "icon" field not found'],
      warnings: [],
    };
  }

  return validateMcaIcon(mcaId, iconField);
}

// ============================================================================
// CLI ENTRY POINT
// ============================================================================

async function main() {
  // Guard: only run when invoked directly, not when imported
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
MCA Icon Validator

Usage:
  bun scripts/validate-icons.ts                    # All MCAs
  bun scripts/validate-icons.ts mca.plaud          # Specific MCA(s)
  bun scripts/validate-icons.ts --help             # This help

Validates icon files against the icon standards
(Section 10 — Icons).

Rules enforced:
  - Icon file must exist (resolved relative to MCA static/ or root)
  - Must be a valid PNG
  - Must be square (width === height)
  - Minimum ${MIN_DIMENSION}×${MIN_DIMENSION} px
  - File size: ≥ ${MIN_FILE_SIZE_BYTES / 1024} KB and ≤ ${MAX_FILE_SIZE_BYTES / 1024} KB
  - Must not be a near-uniform solid-color placeholder
`);
    process.exit(0);
  }

  console.log('🖼️  MCA Icon Validator\n');

  const mcaIds = args.length > 0 ? args : discoverMcas();
  console.log(`Found ${mcaIds.length} MCA(s) to validate\n`);

  const results: IconValidationResult[] = [];

  for (const mcaId of mcaIds) {
    const result = validateMcaIconFromManifest(mcaId);
    results.push(result);

    if (result.valid) {
      const hasWarnings = result.warnings.length > 0;
      console.log(`${hasWarnings ? '⚠️ ' : '✅'} ${mcaId}`);
      result.warnings.forEach((w) => console.log(`   ⚠️  ${w}`));
    } else {
      console.log(`❌ ${mcaId}`);
      result.errors.forEach((e) => console.log(`   - ${e}`));
      result.warnings.forEach((w) => console.log(`   ⚠️  ${w}`));
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  const valid = results.filter((r) => r.valid);
  const invalid = results.filter((r) => !r.valid);

  console.log(`\nSummary: ${valid.length} valid, ${invalid.length} invalid`);

  if (invalid.length > 0) {
    console.log('\nFailing MCAs:');
    invalid.forEach((r) => {
      console.log(`  ❌ ${r.mcaId}`);
      r.errors.forEach((e) => console.log(`       ${e}`));
    });
    process.exit(1);
  }

  console.log('\n✨ All icons are valid!');
  process.exit(0);
}

// Only run as CLI when invoked directly (not when imported as a module)
if (import.meta.main) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
