import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TamaguiProvider, Theme } from 'tamagui'
import type { ReactElement, ReactNode } from 'react'
import config from '../../tamagui.config'
import { colors as semanticColors, surface } from './mca/primitives/colors'
import { TerosLoading } from './TerosLoading'

/**
 * Bug 2026-10-06: TerosLoading's DEFAULT color was a fixed palette step
 * (indigo = Purple/300) — any caller that forgot to pass a color drew a
 * weak-on-dark dot. The default now resolves the ACTIVE theme's accent
 * (Purple/200 dark / Purple/300 light).
 *
 * react-native-svg is mocked HERE (the app-wide vitest alias stub renders
 * null and leaves no DOM trace of the fill) so the circles expose `fill`.
 */
vi.mock('react-native-svg', async () => {
  const React = await import('react')
  const Svg = ({ children }: { children?: ReactNode }) => React.createElement('div', null, children)
  const Circle = ({ fill }: { fill?: string }) => React.createElement('div', { 'data-fill': fill })
  return { default: Svg, Svg, Circle }
})

function renderWithTheme(ui: ReactElement, theme: 'dark' | 'light') {
  return render(
    <TamaguiProvider config={config} defaultTheme={theme}>
      <Theme name={theme}>{ui}</Theme>
    </TamaguiProvider>,
  )
}

function fills(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-fill]')).map(
    (el) => (el as HTMLElement).getAttribute('data-fill') ?? '',
  )
}

afterEach(cleanup)

describe('TerosLoading — default color resolves the active theme (bug 2026-10-06)', () => {
  it('no color prop → the dark accent (Purple/200), never the near-black indigoDark', () => {
    const { container } = renderWithTheme(<TerosLoading />, 'dark')
    const got = fills(container)
    expect(got.length).toBeGreaterThan(0)
    for (const fill of got) {
      expect(fill).toBe(surface.dark.accent)
      expect(fill).not.toBe(semanticColors.indigoDark)
    }
  })

  it('no color prop → the light accent (Purple/300) in light', () => {
    const { container } = renderWithTheme(<TerosLoading />, 'light')
    for (const fill of fills(container)) {
      expect(fill).toBe(surface.light.accent)
    }
  })

  it('an explicit color prop is respected (callers pinning their own surface)', () => {
    const { container } = renderWithTheme(<TerosLoading color="#ABCDEF" />, 'dark')
    for (const fill of fills(container)) {
      expect(fill).toBe('#ABCDEF')
    }
  })
})
