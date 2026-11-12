import '../../i18n' // side-effect: initializes i18n (en-US) so t() returns real strings
import { fireEvent } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderWithTamagui } from '../../test/renderWithTamagui'
import { AcademyWindowContent } from './AcademyWindowContent'
import { ACADEMY_VIDEOS } from '../../data/academyCatalog'

describe('AcademyWindowContent', () => {
  it('renders the catalog and navigates to detail and back', () => {
    const { container, getByText, getAllByText } = renderWithTamagui(<AcademyWindowContent windowId="w1" />)
    // Catalog: header title visible ("Academy"). The detail view has no such title,
    // so it cleanly distinguishes catalog from detail across the navigation below.
    expect(getByText('Academy')).toBeTruthy()

    // Click first card → detail (player iframe appears)
    const firstTitle = ACADEMY_VIDEOS[0].title
    fireEvent.click(getAllByText(new RegExp(firstTitle))[0])
    expect(container.querySelector('iframe')).toBeTruthy()

    // Back → catalog again (no iframe)
    fireEvent.click(getByText(/Back to catalog|Volver al catálogo/))
    expect(container.querySelector('iframe')).toBeNull()
    expect(getByText('Academy')).toBeTruthy()
  })
})
