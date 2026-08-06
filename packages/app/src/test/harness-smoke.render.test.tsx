import { Text } from 'tamagui'
import { describe, expect, it } from 'vitest'
import { renderWithTamagui } from './renderWithTamagui'

/**
 * Smoke test for the render harness (TER-385): proves Tamagui components render
 * into jsdom under Vitest + react-native-web. Once green, real component tests
 * (e.g. withPermissionSupport → ControlsBar on pending_permission) build on this.
 */
describe('render harness', () => {
  it('renders a Tamagui component into jsdom', () => {
    const { getByText } = renderWithTamagui(<Text>hello-harness</Text>)
    expect(getByText('hello-harness')).toBeTruthy()
  })
})
