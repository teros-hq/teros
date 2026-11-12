/**
 * EditorialScreen — the shared editorial card (pretty 404 / root-resolver
 * failure). Extracted from app/+not-found.tsx (session URL phase); the 404
 * and the root resolver's failure state must keep rendering the same card.
 *
 * Assertions that bite the extraction:
 *   - renders title + description + action, and fires onAction on click,
 *   - the optional serif code line ("404") renders when given and is absent
 *     otherwise (the root resolver passes no code),
 *   - the card is theme-adaptive (useColors) — smoke-rendered under the dark
 *     theme like every other component here.
 *
 *   cd packages/app && npx vitest run src/components/ui/EditorialScreen.render.test.tsx
 */
import '../../i18n' // side-effect: initializes i18n (en-US) so t() returns real strings
import { fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EditorialScreen } from './EditorialScreen'
import { renderWithTamagui } from '../../test/renderWithTamagui'

describe('EditorialScreen — shared editorial card', () => {
  it('renders title, description and action; fires onAction on click', () => {
    const onAction = vi.fn()
    const { getByText } = renderWithTamagui(
      <EditorialScreen
        title="We couldn't load your workspace"
        description="We couldn't reach the server. Check your connection and try again."
        actionLabel="Retry"
        onAction={onAction}
      />,
    )

    expect(getByText("We couldn't load your workspace")).toBeTruthy()
    expect(getByText(/couldn't reach the server/)).toBeTruthy()
    expect(getByText('Retry')).toBeTruthy()

    fireEvent.click(getByText('Retry'))
    expect(onAction).toHaveBeenCalledTimes(1)
  })

  it('renders the serif code line when given (the pretty 404) and omits it otherwise (the root resolver)', () => {
    // With a code (the pretty 404): the serif marker renders between logo and title.
    const withCode = renderWithTamagui(
      <EditorialScreen
        code="404"
        title="This page doesn't exist"
        description="The link may be old."
        actionLabel="Go to start"
        onAction={() => {}}
      />,
    )
    expect(withCode.getByText('404')).toBeTruthy()
    withCode.unmount()

    // Without a code (the root resolver): no serif marker — the spacer keeps
    // the card rhythm instead.
    const withoutCode = renderWithTamagui(
      <EditorialScreen
        title="We couldn't load your workspace"
        description="We couldn't reach the server."
        actionLabel="Retry"
        onAction={() => {}}
      />,
    )
    expect(withoutCode.queryByText('404')).toBeNull()
  })
})
