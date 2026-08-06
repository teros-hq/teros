import { render, type RenderResult } from '@testing-library/react'
import type { ReactElement } from 'react'
import { TamaguiProvider } from 'tamagui'
import config from '../../tamagui.config'

/**
 * Render a component inside the app's TamaguiProvider (TER-385).
 * Reusable wrapper for every `*.render.test.tsx`.
 */
export function renderWithTamagui(ui: ReactElement): RenderResult {
  return render(
    <TamaguiProvider config={config} defaultTheme="dark">
      {ui}
    </TamaguiProvider>,
  )
}
