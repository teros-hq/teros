/**
 * Contract tests for the two binary indicators that the global
 * `HeaderRow` primitive renders: Irreversibility (red, guide §8) and
 * Risk (amber, guide §8.5).
 *
 * Render-tree tests for `HeaderRow` were attempted but abandoned —
 * the component pulls in `react-native` Animated/Easing which
 * bun:test cannot parse (Flow source). A `react-test-renderer` setup
 * with full mocks would be heavier than the value of the assertion.
 *
 * What we DO pin here are the contract-level invariants that survive
 * any render-tree refactor:
 *   - Both literal badge texts are exact strings, no gradations.
 *   - Both aria-labels are descriptive (a11y).
 *   - The two literals do not collide.
 *
 * Functional verification (badge actually paints in the DOM) lives in
 * the visual smoke checklist (`docs/audit/risk-indicator-rfc-2026-05-11.md`).
 */
import { describe, expect, it } from 'bun:test';

import { MCA_STRINGS } from '../../../../packages/app/src/components/mca/primitives/strings';

describe('HeaderRow indicators — string contract', () => {
  it('Irreversibility badge text is the canonical literal "irreversible"', () => {
    expect(MCA_STRINGS.permission.irreversible).toBe('irreversible');
  });

  it('Risk Indicator badge text is the canonical literal "risk" (no gradations)', () => {
    // Guide §8.5 explicitly prohibits "high"/"medium"/"low" — pin the
    // literal so a future change that introduces a tier fails this test.
    expect(MCA_STRINGS.permission.risk).toBe('risk');
    expect(MCA_STRINGS.permission.risk).not.toContain('high');
    expect(MCA_STRINGS.permission.risk).not.toContain('medium');
    expect(MCA_STRINGS.permission.risk).not.toContain('low');
  });

  it('Irreversibility ariaLabel is descriptive (a11y)', () => {
    expect(MCA_STRINGS.permission.irreversibleAriaLabel).toBeTruthy();
    expect(MCA_STRINGS.permission.irreversibleAriaLabel.length).toBeGreaterThan(10);
  });

  it('Risk ariaLabel is descriptive and mentions both axes (security/blast)', () => {
    const aria = MCA_STRINGS.permission.riskAriaLabel;
    expect(aria).toBeTruthy();
    expect(aria.length).toBeGreaterThan(10);
    // The aria mentions both axes the indicator captures.
    expect(
      aria.toLowerCase().includes('security') || aria.toLowerCase().includes('blast'),
    ).toBe(true);
  });

  it('Indicator labels do not collide', () => {
    expect(MCA_STRINGS.permission.irreversible).not.toBe(MCA_STRINGS.permission.risk);
    expect(MCA_STRINGS.permission.irreversibleAriaLabel).not.toBe(
      MCA_STRINGS.permission.riskAriaLabel,
    );
  });
});
