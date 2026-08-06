import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { resolveRetention } from '@teros/shared'
import '../../i18n' // initialize i18next (en-US via mocked expo-localization)
import { renderWithTamagui } from '../../test/renderWithTamagui'
import { RetentionConfirmModal } from './RetentionConfirmModal'

describe('RetentionConfirmModal', () => {
  it('shows the title, provider notice and both actions when open', async () => {
    renderWithTamagui(
      <RetentionConfirmModal
        open
        info={resolveRetention('anthropic-oauth')}
        modelName="Claude Pro/Max"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(await screen.findByText('Heads up about your data')).toBeTruthy()
    expect(screen.getByText(/Claude Pro\/Max trains on your conversations/i)).toBeTruthy()
    expect(screen.getByTestId('retention-confirm-accept')).toBeTruthy()
    expect(screen.getByTestId('retention-confirm-cancel')).toBeTruthy()
  })

  it('fires onConfirm and onCancel from the buttons', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    renderWithTamagui(
      <RetentionConfirmModal
        open
        info={resolveRetention('minimax')}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )
    fireEvent.click(await screen.findByTestId('retention-confirm-accept'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('retention-confirm-cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('renders nothing when closed', () => {
    renderWithTamagui(
      <RetentionConfirmModal open={false} info={null} onConfirm={() => {}} onCancel={() => {}} />,
    )
    expect(screen.queryByTestId('retention-confirm-modal')).toBeNull()
  })
})
