/**
 * Adoption test for the `ToolCallCard` refactor (Plan TER-186 Fases 2-6).
 *
 * The migration replaces local `HeaderRow` definitions with the
 * primitive `ToolCallCard`, eliminating ~23 sites where the
 * permission flow (ControlsBar + Irreversibility/Risk indicators) had
 * to be re-wired manually. A migrated renderer source file:
 *   1. imports `ToolCallCard` from `../primitives`,
 *   2. does NOT define a local `function HeaderRow(...)` or similar,
 *   3. does NOT import `ControlsBar` directly (the card handles it).
 *
 * AUTO-DERIVED since TER-465: the migrated set is no longer a hand-kept
 * array — every `.tsx` under `renderers/` (recursive) that imports
 * `ToolCallCard` enters the pin automatically, so new renderers cannot
 * escape it. Deliberate non-adopters (BashRenderer/AdminBashRenderer wrap
 * ControlsBar manually via BashRendererCore; BrowserbaseRenderer predates
 * the push) fall out naturally because they don't import the card.
 *
 * Anti-shrink guard: `MINIMUM_MIGRATED` freezes the set at the moment of
 * the derivation switch. If a renderer DROPS its ToolCallCard import, the
 * derive would silently remove it from the pin — the subset assertion
 * turns that into a red instead.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const RENDERERS_ROOT = resolve(
  __dirname,
  '../../../../packages/app/src/components/mca/renderers',
);

/**
 * Frozen floor (TER-465, 2026-06-05): renderers that MUST keep importing
 * ToolCallCard. Growth is automatic; shrinkage is a regression.
 */
const MINIMUM_MIGRATED: ReadonlyArray<string> = [
  'ActiveCampaignRenderer.tsx',
  'BoardRenderer.tsx',
  'BrevoRenderer.tsx',
  'brevo/CreateContactRenderer.tsx',
  'brevo/HealthCheckRenderer.tsx',
  'brevo/ListCampaignsRenderer.tsx',
  'brevo/ListContactsRenderer.tsx',
  'brevo/SendEmailRenderer.tsx',
  'CalendarRenderer.tsx',
  'CanvaRenderer.tsx',
  'ContactsRenderer.tsx',
  'Context7Renderer.tsx',
  'ConversationsRenderer.tsx',
  'DockerEnvRenderer.tsx',
  'DriveRenderer.tsx',
  'ElevenLabsRenderer.tsx',
  'FeedbackRenderer.tsx',
  'FigmaRenderer.tsx',
  'FilesystemRenderer.tsx',
  'GmailRenderer.tsx',
  'github/GitHubRenderer.tsx',
  'http/HealthCheckRenderer.tsx',
  'http/RequestRenderer.tsx',
  'GoogleAnalyticsRenderer.tsx',
  'google-analytics/shared.tsx',
  'HunterRenderer.tsx',
  'LinearRenderer.tsx',
  'MakeRenderer.tsx',
  'MessagingRenderer.tsx',
  'NetlifyRenderer.tsx',
  'netlify/DeployResultRenderer.tsx',
  'netlify/DeployStatusRenderer.tsx',
  'netlify/HealthCheckRenderer.tsx',
  'netlify/SitesListRenderer.tsx',
  'NotionRenderer.tsx',
  'OutlookRenderer.tsx',
  'PerplexityRenderer.tsx',
  'RailwayRenderer.tsx',
  'RenderRenderer.tsx',
  'RendererTemplate.tsx',
  'ReplicateRenderer.tsx',
  'scheduler/index.tsx',
  'SlackRenderer.tsx',
  'TerosCoreRenderer.tsx',
  'WhatsappRenderer.tsx',
];

const IMPORTS_CARD =
  /import\s*\{[^}]*\bToolCallCard\b[^}]*\}\s*from\s*['"][^'"]*primitives['"]/;

/** Every .tsx under renderers/ (recursive), as posix-style relative paths. */
const allRendererFiles = readdirSync(RENDERERS_ROOT, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.tsx'))
  .map((f) => f.split('\\').join('/'))
  .sort();

function read(name: string): string {
  return readFileSync(join(RENDERERS_ROOT, name), 'utf8');
}

/** Derived set: any renderer source that imports the ToolCallCard primitive. */
const MIGRATED = allRendererFiles.filter((f) => IMPORTS_CARD.test(read(f)));

describe('ToolCallCard adoption — derivation sanity', () => {
  it('the scan sees the tree (anti-NO-OP: >100 files, >50 migrated)', () => {
    expect(allRendererFiles.length).toBeGreaterThan(100);
    expect(MIGRATED.length).toBeGreaterThan(50);
  });

  it('anti-shrink: every frozen renderer still imports ToolCallCard', () => {
    const derived = new Set(MIGRATED);
    const dropped = MINIMUM_MIGRATED.filter((name) => !derived.has(name));
    expect(dropped).toEqual([]);
  });

  it('deliberate non-adopters stay out until they import the card', () => {
    const derived = new Set(MIGRATED);
    // If any of these starts importing ToolCallCard it simply enters the
    // pin automatically — this assert documents today's exclusions and
    // fails loudly so the exception list gets updated consciously.
    for (const excluded of [
      'BashRenderer.tsx',
      'AdminBashRenderer.tsx',
      'BrowserbaseRenderer.tsx',
    ]) {
      expect(derived.has(excluded)).toBe(false);
    }
  });
});

describe('ToolCallCard adoption — migrated renderers', () => {
  for (const name of MIGRATED) {
    describe(name, () => {
      const src = read(name);

      it('does NOT define a local function HeaderRow', () => {
        // A local definition would shadow the primitive and re-introduce
        // the duplication the migration aims to eliminate. Permit the
        // type import `HeaderRowProps` (typing reference is fine), but
        // not a `function HeaderRow(`.
        const hasLocalHeaderRow = /\bfunction\s+HeaderRow\s*\(/.test(src);
        expect(hasLocalHeaderRow).toBe(false);
      });

      it('does NOT import ControlsBar directly', () => {
        // The card mounts the ControlsBar itself via the permission
        // context. A direct import here would be either dead code or
        // a sign that the renderer is rebuilding the permission flow
        // it shouldn't own.
        const hasControlsBarImport = /import\s*\{[^}]*\bControlsBar\b[^}]*\}\s*from/.test(
          src,
        );
        expect(hasControlsBarImport).toBe(false);
      });
    });
  }
});
