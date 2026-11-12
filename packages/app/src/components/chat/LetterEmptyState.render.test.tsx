import { screen, waitFor } from '@testing-library/react'
import { renderWithTamagui as render } from '../../test/renderWithTamagui'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const letter = vi.fn()
vi.mock('../../services/terosClientSingleton', () => ({
  getTerosClient: () => ({ channel: { letter } }),
}))

import { LetterEmptyState } from './LetterEmptyState'

beforeEach(() => {
  letter.mockReset()
  letter.mockResolvedValue({ generated: true, segments: [{ type: 'text', value: 'Two tasks moved today.' }], prompts: [] })
})

const baseProps = {
  agentName: 'Iria',
  agentAvatarUrl: null,
  userName: 'Pablo López',
  onPromptSelected: () => {},
}

describe('LetterEmptyState', () => {
  it('[CSUM-AC-3] summary off: only the greeting, no letter request, no starters', async () => {
    render(<LetterEmptyState {...baseProps} agentId="agent_off" workspaceId="ws_off" showSummary={false} />)
    // i18n is not loaded in unit tests: the greeting renders as its key.
    expect(screen.getByText('conversation.letter.greeting')).toBeTruthy()
    expect(screen.queryByText('conversation.letter.startHere')).toBeNull()
    await new Promise((r) => setTimeout(r, 50))
    expect(letter).not.toHaveBeenCalled()
    expect(screen.queryByText('Two tasks moved today.')).toBeNull()
  })

  it('[CSUM-AC-3] summary on: the letter is requested', async () => {
    render(<LetterEmptyState {...baseProps} agentId="agent_on" workspaceId="ws_on" showSummary />)
    await waitFor(() => expect(letter).toHaveBeenCalledTimes(1))
  })
})
