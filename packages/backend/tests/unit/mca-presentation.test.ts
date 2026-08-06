/**
 * Unit — MCA presentation derivations materialised in the sync (TER-538).
 *
 * These run once per MCA during `sync-mcas` and feed the catalog, so a wrong
 * derivation ships bad data to every client. Each helper is asserted on an
 * exact, mutation-sensitive payload.
 */

import { describe, expect, it } from 'bun:test';
import { PNG } from 'pngjs';
import {
  derivePermissions,
  extractAccentColors,
  humanizeToolDescription,
  toolGroup,
} from '../../src/lib/mca-presentation';

function makePng(fill: (x: number, y: number) => [number, number, number, number], w = 16, h = 16): PNG {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const [r, g, b, a] = fill(x, y);
      png.data[o] = r;
      png.data[o + 1] = g;
      png.data[o + 2] = b;
      png.data[o + 3] = a;
    }
  }
  return png;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

describe('extractAccentColors', () => {
  it('two saturated halves → two diverse brand colours (one red, one green)', () => {
    // left half #EA4335, right half #34A853
    const png = makePng((x) => (x < 8 ? [234, 67, 53, 255] : [52, 168, 83, 255]));
    const colors = extractAccentColors(png);
    expect(colors.length).toBe(2);
    const rgbs = colors.map(hexToRgb);
    expect(rgbs.some(([r, g, b]) => r > 150 && r > g && r > b)).toBe(true); // red-dominant
    expect(rgbs.some(([r, g, b]) => g > 120 && g > r && g > b)).toBe(true); // green-dominant
  });

  it('monochrome grey logo → [] (no brand colour to extract)', () => {
    const png = makePng(() => [128, 128, 128, 255]);
    expect(extractAccentColors(png)).toEqual([]);
  });

  it('desaturated tint (sat below threshold) is dropped → []', () => {
    // #88847C — a warm-grey with saturation ~0.09, below the 0.18 cutoff.
    // Pure greys are killed by the weight filter, but this one is only
    // excluded by the saturation guard — so it bites that filter directly.
    const png = makePng(() => [136, 132, 124, 255]);
    expect(extractAccentColors(png)).toEqual([]);
  });

  it('near-white and near-black are dropped → []', () => {
    const png = makePng((x) => (x < 8 ? [250, 250, 250, 255] : [6, 6, 6, 255]));
    expect(extractAccentColors(png)).toEqual([]);
  });

  it('fully transparent → []', () => {
    const png = makePng(() => [234, 67, 53, 0]);
    expect(extractAccentColors(png)).toEqual([]);
  });

  it('caps at `max` colours', () => {
    // four distinct saturated quadrants, max=2
    const png = makePng((x, y) => {
      if (x < 8 && y < 8) return [234, 67, 53, 255]; // red
      if (x >= 8 && y < 8) return [52, 168, 83, 255]; // green
      if (x < 8 && y >= 8) return [66, 133, 244, 255]; // blue
      return [251, 188, 4, 255]; // yellow
    });
    expect(extractAccentColors(png, 2).length).toBe(2);
  });
});

describe('toolGroup', () => {
  it('strips the verb and pluralises the noun', () => {
    expect(toolGroup('get-page')).toBe('Pages');
    expect(toolGroup('query-database')).toBe('Databases');
    expect(toolGroup('create-comment')).toBe('Comments');
    expect(toolGroup('get-block-children')).toBe('Blocks');
  });
  it('pluralises s/x/ch/sh endings with -es', () => {
    expect(toolGroup('list-box')).toBe('Boxes');
  });
  it('verb-only / unknown → Other', () => {
    expect(toolGroup('search')).toBe('Other');
    expect(toolGroup('-health-check')).toBe('Healths'); // health is a noun here; lands in its own bucket, collapsed later
  });
});

describe('humanizeToolDescription', () => {
  it('cuts the agent-facing return/params jargon', () => {
    expect(
      humanizeToolDescription('Search pages & databases by title. Returns curated rows { id }. Params: query.'),
    ).toBe('Search pages & databases by title.');
    expect(humanizeToolDescription('Retrieve a page. Returns curated { id }.')).toBe('Retrieve a page.');
  });
  it('keeps a clean human sentence untouched (adds trailing period)', () => {
    expect(humanizeToolDescription('Edit an existing comment')).toBe('Edit an existing comment.');
  });
  it('empty → empty', () => {
    expect(humanizeToolDescription('')).toBe('');
    expect(humanizeToolDescription(undefined)).toBe('');
  });
});

describe('derivePermissions', () => {
  it('http transport → network + filesystem', () => {
    expect(derivePermissions({ transport: 'http' })).toEqual([
      { type: 'network', label: 'Network', detail: 'Outbound HTTP' },
      { type: 'filesystem', label: 'Filesystem', detail: 'Read/write' },
    ]);
  });
  it('stdio transport → filesystem only', () => {
    expect(derivePermissions({ transport: 'stdio' })).toEqual([
      { type: 'filesystem', label: 'Filesystem', detail: 'Read/write' },
    ]);
  });
  it('no runtime → filesystem only', () => {
    expect(derivePermissions(null)).toEqual([
      { type: 'filesystem', label: 'Filesystem', detail: 'Read/write' },
    ]);
  });
});
