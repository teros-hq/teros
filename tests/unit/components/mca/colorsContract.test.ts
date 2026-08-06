/**
 * Contract tests for the v2 design tokens.
 *
 * These tests pin the **exact** hex values and shape of the tokens
 * exported by `primitives/colors.ts` against the canonical visual spec
 * (`docs/mcas/renderer-ux-guide.html`). They catch the kind of silent
 * drift that snapshot tests are designed to catch — but without needing
 * Tamagui rendering infrastructure.
 *
 * Design intent:
 * - Surface tokens may change hex per theme, but the **shape** (key set)
 *   must stay stable across themes.
 * - Semantic tokens are theme-agnostic — the hex is the contract.
 * - Status dot colors come straight from the guide §3 — never override.
 * - Badge palettes have the same 5 keys (ok/err/warn/gray/info) in
 *   both themes; only hex shifts.
 *
 * If a hex changes here, update the guide HTML first.
 */
import { describe, expect, it } from 'bun:test';

import {
  badges,
  colors,
  statusDotColors,
  surface,
} from '../../../../packages/app/src/components/mca/primitives/colors';

describe('semantic tokens (theme-agnostic)', () => {
  it('matches renderer-ux-guide.html §5 exactly', () => {
    expect(colors.indigo).toBe('#5E6AD2');
    expect(colors.indigoLight).toBe('#7B82E0');
    expect(colors.indigoDark).toBe('#4A52B8');
    expect(colors.violet).toBe('#8B5CF6');
    expect(colors.green).toBe('#22C55E');
    expect(colors.amber).toBe('#F59E0B');
    expect(colors.red).toBe('#EF4444');
    expect(colors.orange).toBe('#F97316');
  });
});

describe('status dot colors (renderer-ux-guide.html §3)', () => {
  it('exposes exactly the 5 statuses required by v2', () => {
    expect(Object.keys(statusDotColors).sort()).toEqual([
      'completed',
      'failed',
      'pending',
      'pending_permission',
      'running',
    ]);
  });

  it('pending = orange, no pulse', () => {
    expect(statusDotColors.pending.fill).toBe('#F97316');
    expect(statusDotColors.pending.pulse).toBe(false);
  });

  it('running = indigo, pulse', () => {
    expect(statusDotColors.running.fill).toBe('#5E6AD2');
    expect(statusDotColors.running.pulse).toBe(true);
  });

  it('completed = green, no pulse', () => {
    expect(statusDotColors.completed.fill).toBe('#22C55E');
    expect(statusDotColors.completed.pulse).toBe(false);
  });

  it('failed = red, no pulse', () => {
    expect(statusDotColors.failed.fill).toBe('#EF4444');
    expect(statusDotColors.failed.pulse).toBe(false);
  });

  it('pending_permission = violet, pulse', () => {
    expect(statusDotColors.pending_permission.fill).toBe('#8B5CF6');
    expect(statusDotColors.pending_permission.pulse).toBe(true);
  });
});

describe('surface tokens', () => {
  const requiredKeys = [
    'bgPage',
    'bgCard',
    'bgCardHover',
    'bgInner',
    'border',
    'borderStrong',
    'text',
    'text2',
    'text3',
    'shadow',
    'shadowSm',
  ] as const;

  it('exposes both dark and light themes', () => {
    expect(Object.keys(surface).sort()).toEqual(['dark', 'light']);
  });

  it('dark theme has all required keys', () => {
    for (const key of requiredKeys) {
      expect(surface.dark[key]).toBeDefined();
      expect(typeof surface.dark[key]).toBe('string');
    }
  });

  it('light theme has all required keys', () => {
    for (const key of requiredKeys) {
      expect(surface.light[key]).toBeDefined();
      expect(typeof surface.light[key]).toBe('string');
    }
  });

  it('dark surface matches guide v2 dark palette', () => {
    expect(surface.dark.bgPage).toBe('#0A0A0F');
    expect(surface.dark.bgCard).toBe('#16161D');
    expect(surface.dark.text).toBe('#E4E4E7');
    expect(surface.dark.text2).toBe('#A1A1AA');
    expect(surface.dark.text3).toBe('#52525B');
  });

  it('light surface matches guide v2 cream palette', () => {
    expect(surface.light.bgPage).toBe('#EFE9DB');
    expect(surface.light.text).toBe('#1A1A1F');
    expect(surface.light.text2).toBe('#4A4A5A');
    expect(surface.light.text3).toBe('#8A8A9A');
  });
});

describe('badge palettes', () => {
  const requiredVariants = ['ok', 'err', 'warn', 'gray', 'info'] as const;

  it('exposes both dark and light palettes', () => {
    expect(Object.keys(badges).sort()).toEqual(['dark', 'light']);
  });

  it('every variant has text + bg + border in both themes', () => {
    for (const theme of ['dark', 'light'] as const) {
      for (const variant of requiredVariants) {
        const v = badges[theme][variant];
        expect(v.text).toBeDefined();
        expect(v.bg).toBeDefined();
        expect(v.border).toBeDefined();
      }
    }
  });
});

describe('legacy compat shims', () => {
  // The legacy keys exist so 70+ existing renderers keep compiling.
  // Removing them silently would break dozens of callers; we pin them.
  it('preserves the pre-v2 status aliases', () => {
    expect(colors.success).toBe(colors.green);
    expect(colors.running).toBe(colors.indigo);
    expect(colors.failed).toBe(colors.red);
    expect(colors.warning).toBe(colors.amber);
  });

  it('preserves the pre-v2 text scale aliases', () => {
    expect(colors.primary).toBe(surface.dark.text);
    expect(colors.secondary).toBe(surface.dark.text2);
    expect(colors.muted).toBe(surface.dark.text3);
  });

  it('preserves the pre-v2 badge accessors', () => {
    expect(colors.badgeSuccess.text).toBe(badges.dark.ok.text);
    expect(colors.badgeError.text).toBe(badges.dark.err.text);
    expect(colors.badgeInfo.text).toBe(badges.dark.info.text);
    expect(colors.badgeWarning.text).toBe(badges.dark.warn.text);
    expect(colors.badgeGray.text).toBe(badges.dark.gray.text);
  });
});
