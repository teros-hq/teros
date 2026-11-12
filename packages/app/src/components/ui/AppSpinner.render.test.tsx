import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TamaguiProvider, Theme } from 'tamagui'
import type { ReactElement } from 'react'
import config from '../../../tamagui.config'
import { colors as semanticColors, surface } from '../mca/primitives/colors'
import { AppSpinner } from './AppSpinner'

/**
 * Regression test for the invisible-loader bug (2026-10-06): spinners drew
 * FIXED palette colors — `indigoDark` #1C0252 rode black-on-black on dark
 * surfaces, and the fixed brand Purple/300 managed only 2.71:1 in dark.
 * These tests pin every variant's resolved color per theme so no variant can
 * silently regress to a fixed ramp step again.
 *
 * TerosLoading is mocked to capture its props — the COLOR RESOLUTION is the
 * unit under test (the SVG itself is stubbed app-wide, see vitest.config.ts).
 */
const h = vi.hoisted(() => ({ props: [] as Array<{ size?: number; color?: string }> }))

vi.mock('../TerosLoading', () => ({
  TerosLoading: (props: { size?: number; color?: string }) => {
    h.props.push(props)
    return null
  },
}))

function renderWithTheme(ui: ReactElement, theme: 'dark' | 'light') {
  return render(
    <TamaguiProvider config={config} defaultTheme={theme}>
      <Theme name={theme}>{ui}</Theme>
    </TamaguiProvider>,
  )
}

/** The last captured color of a render pass (React may re-render the mock). */
function lastColor(): string | undefined {
  return h.props[h.props.length - 1]?.color
}

afterEach(() => {
  cleanup()
  h.props.length = 0
})

describe('AppSpinner — accent variants resolve the ACTIVE theme (bug 2026-10-06)', () => {
  it('brand rides the dark accent (Purple/200) — not the old fixed Purple/300', () => {
    renderWithTheme(<AppSpinner variant="brand" />, 'dark')
    expect(lastColor()).toBe(surface.dark.accent)
    // The old bug: the light-theme accent step worn in dark (2.71:1 on Main/900).
    expect(lastColor()).not.toBe(semanticColors.indigo)
  })

  it('brand rides the light accent (Purple/300) in light', () => {
    renderWithTheme(<AppSpinner variant="brand" />, 'light')
    expect(lastColor()).toBe(surface.light.accent)
  })

  it('default and board share the theme accent with brand', () => {
    for (const variant of ['default', 'board'] as const) {
      h.props.length = 0
      renderWithTheme(<AppSpinner variant={variant} />, 'dark')
      expect(lastColor()).toBe(surface.dark.accent)
    }
  })

  it('never resolves the near-black indigoDark (#1C0252) — Pablo repro', () => {
    for (const theme of ['dark', 'light'] as const) {
      for (const variant of ['default', 'brand', 'board'] as const) {
        h.props.length = 0
        renderWithTheme(<AppSpinner variant={variant} />, theme)
        expect(lastColor()).not.toBe(semanticColors.indigoDark)
      }
    }
  })
})

describe('AppSpinner — surface variants', () => {
  it('muted rides the theme text3', () => {
    renderWithTheme(<AppSpinner variant="muted" />, 'dark')
    expect(lastColor()).toBe(surface.dark.text3)
    h.props.length = 0
    renderWithTheme(<AppSpinner variant="muted" />, 'light')
    expect(lastColor()).toBe(surface.light.text3)
  })

  it('onDark rides adaptive ink — white in dark, theme text in light', () => {
    renderWithTheme(<AppSpinner variant="onDark" />, 'dark')
    expect(lastColor()).toBe('#FFFFFF')
    h.props.length = 0
    renderWithTheme(<AppSpinner variant="onDark" />, 'light')
    expect(lastColor()).toBe(surface.light.text)
  })

  it('onFill rides WHITE in both themes — for solid brand fills (violet/green/red buttons)', () => {
    renderWithTheme(<AppSpinner variant="onFill" />, 'dark')
    expect(lastColor()).toBe('#FFFFFF')
    h.props.length = 0
    renderWithTheme(<AppSpinner variant="onFill" />, 'light')
    expect(lastColor()).toBe('#FFFFFF')
  })
})

describe('AppSpinner — status variants stay semantic (theme-agnostic on purpose)', () => {
  it('danger/success/warning ride the semantic status colors', () => {
    renderWithTheme(<AppSpinner variant="danger" />, 'dark')
    expect(lastColor()).toBe(semanticColors.red)
    h.props.length = 0
    renderWithTheme(<AppSpinner variant="success" />, 'light')
    expect(lastColor()).toBe(semanticColors.green)
    h.props.length = 0
    renderWithTheme(<AppSpinner variant="warning" />, 'dark')
    expect(lastColor()).toBe(semanticColors.amber)
  })
})

describe('AppSpinner — explicit color still wins', () => {
  it('the color prop takes precedence over the variant', () => {
    renderWithTheme(<AppSpinner variant="brand" color="#123456" />, 'dark')
    expect(lastColor()).toBe('#123456')
  })
})
