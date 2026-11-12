import { describe, expect, it } from 'vitest'
import { shouldShowMsgActions } from './msgActions'

describe('.msg-actions gating', () => {
  const base = { isLastMessage: true, turnDone: true, isStreaming: false }
  it('shows only on the last message once the turn is done', () => {
    expect(shouldShowMsgActions(base)).toBe(true)
  })
  it('hides on historical / intermediate messages', () => {
    expect(shouldShowMsgActions({ ...base, isLastMessage: false })).toBe(false)
  })
  it('hides while the turn is live (also on scroll-back)', () => {
    expect(shouldShowMsgActions({ ...base, turnDone: false })).toBe(false)
  })
  it('hides while the message is streaming', () => {
    expect(shouldShowMsgActions({ ...base, isStreaming: true })).toBe(false)
  })
})
