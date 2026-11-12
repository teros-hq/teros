import '../../i18n' // side-effect: initializes i18n (en-US) so t() returns real strings
import { fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithTamagui } from '../../test/renderWithTamagui'
import { AcademyCatalog } from './AcademyCatalog'
import { ACADEMY_PHASES, ACADEMY_VIDEOS } from '../../data/academyCatalog'

describe('AcademyCatalog', () => {
  it('renders the flat grid header and calls onSelectVideo when a card is pressed', () => {
    const onSelect = vi.fn()
    const { getByText, getAllByText } = renderWithTamagui(<AcademyCatalog onSelectVideo={onSelect} />)
    // Header title (unique to the catalog chrome, en-US).
    expect(getByText('Academy')).toBeTruthy()
    // First video card title from placeholder data ("Tutorial 1"). The grid is flat
    // and sorted by phase order then number, so results[0] is phase1's first video =
    // ACADEMY_VIDEOS[0]; every phase has a "Tutorial 1", so take [0].
    const firstTitle = ACADEMY_VIDEOS[0].title
    fireEvent.click(getAllByText(new RegExp(firstTitle))[0])
    expect(onSelect).toHaveBeenCalledWith(ACADEMY_VIDEOS[0].id)
  })

  it('filters to no results for a nonsense query', () => {
    const { getByPlaceholderText, getByText } = renderWithTamagui(<AcademyCatalog onSelectVideo={() => {}} />)
    const input = getByPlaceholderText(/Search tutorials|Buscar tutoriales/)
    fireEvent.change(input, { target: { value: 'zzzzzzzznomatch' } })
    expect(getByText(/No tutorials match|Ningún tutorial coincide/)).toBeTruthy()
  })

  it('surfaces the selected phase title + description when its chip is picked', () => {
    const { getByText, queryByText, getByLabelText } = renderWithTamagui(<AcademyCatalog onSelectVideo={() => {}} />)
    const phase = ACADEMY_PHASES[0]
    // With "All" selected, the phase description is not shown.
    expect(queryByText(phase.description)).toBeNull()
    // The chip's accessible label is the full phase title (chip text is just "Phase N").
    fireEvent.click(getByLabelText(phase.title))
    // Selecting the chip surfaces the phase title + description header.
    expect(getByText(phase.description)).toBeTruthy()
  })
})
