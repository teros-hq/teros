/**
 * Unit tests for message redaction enforcement (REQ-4, REQ-5, NFR-2, AC-5..AC-7).
 *
 * AC-5: Owner can redact a message — owner always sees full content (click-to-reveal).
 * AC-6: Non-owner cannot see redacted content — the serialized JSON payload
 *        must NOT contain the original content in any form.
 * AC-7: Owner can un-redact — content becomes visible to non-owners again.
 *
 * The audit test (AC-6) serializes the entire non-owner response to JSON and
 * asserts the original text does not appear anywhere in the payload.
 */

import { describe, expect, test } from 'bun:test'
import {
  redactMessagesForViewer,
  redactMessageForViewer,
  obfuscateText,
} from './redact-messages'
import type { Message } from '@teros/shared'

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const SECRET_TEXT = 'My API key is sk-abc123def456 and my password is hunter2'
const NORMAL_TEXT = 'Hello world, this is a normal message'

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    messageId: 'msg_001',
    channelId: 'ch_test',
    role: 'user',
    content: { type: 'text', text: SECRET_TEXT },
    timestamp: '2026-09-14T20:00:00.000Z',
    ...overrides,
  } as Message
}

function makeRedactedMessage(overrides: Partial<Message> = {}): Message {
  return makeMessage({
    redacted: true,
    redactedBy: 'user_owner',
    redactedAt: '2026-09-14T20:30:00.000Z',
    ...overrides,
  })
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('redactMessagesForViewer', () => {
  // AC-5: Owner sees full content even when redacted
  test('AC-5: owner receives full unredacted content for redacted messages', () => {
    const messages = [
      makeRedactedMessage(),
      makeMessage({ messageId: 'msg_002', content: { type: 'text', text: NORMAL_TEXT } }),
    ]

    const result = redactMessagesForViewer(messages, true) // isOwner = true

    expect(result).toHaveLength(2)
    // Redacted message: owner sees original content
    expect(result[0].content).toEqual({ type: 'text', text: SECRET_TEXT })
    expect(result[0].redacted).toBe(true)
    expect(result[0].redactedPlaceholder).toBeUndefined()
    // Normal message: unchanged
    expect(result[1].content).toEqual({ type: 'text', text: NORMAL_TEXT })
  })

  // AC-6: Non-owner cannot see redacted content — JSON audit test
  test('AC-6: non-owner payload does NOT contain original content in any form (JSON audit)', () => {
    const messages = [
      makeRedactedMessage(),
      makeMessage({ messageId: 'msg_002', content: { type: 'text', text: NORMAL_TEXT } }),
    ]

    const result = redactMessagesForViewer(messages, false) // isOwner = false

    expect(result).toHaveLength(2)

    // Redacted message: content is obfuscated (not null — structure preserved)
    expect(result[0].content).not.toBeNull()
    expect(result[0].content!.type).toBe('text')
    // The text should be the obfuscated version — all alphanumeric replaced with ·
    expect(result[0].content!.text).toBe(obfuscateText(SECRET_TEXT))
    // No alphanumeric characters from the original should remain
    expect(result[0].content!.text).not.toMatch(/[\p{L}\p{N}]/u)
    expect(result[0].redacted).toBe(true)
    expect(result[0].redactedPlaceholder).toBeDefined()
    expect(result[0].redactedPlaceholder!.type).toBe('redacted')
    expect(result[0].redactedPlaceholder!.reason).toBe('protected_by_owner')
    expect(result[0].redactedPlaceholder!.originalAuthor).toBe('user')
    expect(result[0].redactedPlaceholder!.originalTimestamp).toBe('2026-09-14T20:00:00.000Z')

    // Normal message: non-owner sees content normally
    expect(result[1].content).toEqual({ type: 'text', text: NORMAL_TEXT })

    // ── JSON AUDIT: the serialized payload must NOT contain the secret text ──
    // This is the critical security test (NFR-2).
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('sk-abc123def456')
    expect(serialized).not.toContain('hunter2')
    expect(serialized).not.toContain('My API key')
    expect(serialized).not.toContain('password')
    // The original text must not appear in ANY form in the payload
    expect(serialized).not.toContain(SECRET_TEXT)
  })

  // AC-6 extended: verify content text is fully stripped even with metadata
  test('AC-6: non-owner payload does not contain content text from redacted messages with metadata', () => {
    const complexMessage = makeRedactedMessage({
      metadata: { toolResult: 'sensitive_tool_output' },
    })

    const result = redactMessagesForViewer([complexMessage], false)
    const serialized = JSON.stringify(result)

    // Content is obfuscated (not null — structure preserved)
    expect(result[0].content).not.toBeNull()
    expect(result[0].content!.type).toBe('text')
    expect(result[0].content!.text).not.toMatch(/[\p{L}\p{N}]/u)

    // The original secret text must not appear anywhere in the serialized payload
    expect(serialized).not.toContain('sk-abc123def456')
    expect(serialized).not.toContain('hunter2')
    expect(serialized).not.toContain(SECRET_TEXT)
  })

  // AC-7: Un-redact restores visibility for non-owners
  test('AC-7: un-redacted message is visible to non-owners', () => {
    // First: message is redacted, non-owner sees obfuscated content
    const redactedMsg = makeRedactedMessage()
    const redactedResult = redactMessagesForViewer([redactedMsg], false)
    expect(redactedResult[0].content).not.toBeNull()
    expect(redactedResult[0].content!.type).toBe('text')
    expect(redactedResult[0].content!.text).not.toMatch(/[\p{L}\p{N}]/u)

    // Then: owner un-redacts the message (redacted: false)
    const unredactedMsg = makeMessage({ redacted: false })
    const unredactedResult = redactMessagesForViewer([unredactedMsg], false)
    expect(unredactedResult[0].content).toEqual({ type: 'text', text: SECRET_TEXT })
    expect(unredactedResult[0].redactedPlaceholder).toBeUndefined()
  })

  // Edge case: non-redacted messages are never affected
  test('non-redacted messages pass through unchanged for non-owners', () => {
    const messages = [
      makeMessage({ messageId: 'msg_001', content: { type: 'text', text: NORMAL_TEXT } }),
      makeMessage({ messageId: 'msg_002', content: { type: 'text', text: 'Second message' } }),
    ]

    const result = redactMessagesForViewer(messages, false)
    expect(result[0].content).toEqual({ type: 'text', text: NORMAL_TEXT })
    expect(result[1].content).toEqual({ type: 'text', text: 'Second message' })
  })

  // Edge case: empty message list
  test('empty message list returns empty for both owner and non-owner', () => {
    expect(redactMessagesForViewer([], true)).toEqual([])
    expect(redactMessagesForViewer([], false)).toEqual([])
  })

  // Edge case: all messages redacted, non-owner
  test('all messages redacted: non-owner sees only placeholders', () => {
    const messages = [
      makeRedactedMessage({ messageId: 'msg_001', content: { type: 'text', text: 'secret1' } }),
      makeRedactedMessage({ messageId: 'msg_002', content: { type: 'text', text: 'secret2' } }),
    ]

    const result = redactMessagesForViewer(messages, false)
    expect(result).toHaveLength(2)
    // Content is obfuscated (not null — structure preserved)
    expect(result[0].content).not.toBeNull()
    expect(result[0].content!.type).toBe('text')
    expect(result[1].content).not.toBeNull()
    expect(result[1].content!.type).toBe('text')
    expect(result[0].redactedPlaceholder).toBeDefined()
    expect(result[1].redactedPlaceholder).toBeDefined()

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('secret1')
    expect(serialized).not.toContain('secret2')
  })

  // Edge case: assistant role preserved in placeholder
  test('placeholder preserves original author role for assistant messages', () => {
    const msg = makeRedactedMessage({ role: 'assistant' })
    const result = redactMessagesForViewer([msg], false)
    expect(result[0].redactedPlaceholder!.originalAuthor).toBe('assistant')
  })

  // Edge case: timestamp preserved in placeholder
  test('placeholder preserves original timestamp', () => {
    const msg = makeRedactedMessage({ timestamp: '2026-01-15T10:30:00.000Z' })
    const result = redactMessagesForViewer([msg], false)
    expect(result[0].redactedPlaceholder!.originalTimestamp).toBe('2026-01-15T10:30:00.000Z')
  })
})

describe('obfuscateText', () => {
  test('replaces all alphanumeric characters with middle dot', () => {
    expect(obfuscateText('hello')).toBe('·····')
    expect(obfuscateText('ABC123')).toBe('······')
    expect(obfuscateText('Hello World 123')).toBe('····· ····· ···')
  })

  test('preserves Markdown syntax characters', () => {
    const markdown = '## Header\n- List item\n`code`\n**bold**\n> quote'
    const result = obfuscateText(markdown)
    // Markdown syntax chars preserved
    expect(result).toContain('##')
    expect(result).toContain('-')
    expect(result).toContain('`')
    expect(result).toContain('**')
    expect(result).toContain('>')
    // No alphanumeric chars remain
    expect(result).not.toMatch(/[\p{L}\p{N}]/u)
  })

  test('preserves whitespace, punctuation, and special characters', () => {
    const text = 'Hello, world! @email #tag $100 (test) [link]'
    const result = obfuscateText(text)
    expect(result).toContain(',')
    expect(result).toContain('!')
    expect(result).toContain('@')
    expect(result).toContain('#')
    expect(result).toContain('$')
    expect(result).toContain('(')
    expect(result).toContain(')')
    expect(result).toContain('[')
    expect(result).toContain(']')
    expect(result).not.toMatch(/[\p{L}\p{N}]/u)
  })

  test('preserves email and URL structure while obfuscating text', () => {
    const text = 'Contact: pablo@teros.ai'
    const result = obfuscateText(text)
    // The @ and . are preserved, but all letters are replaced
    expect(result).toContain(':')
    expect(result).toContain('@')
    expect(result).toContain('.')
    expect(result).not.toMatch(/[\p{L}\p{N}]/u)
    expect(result).toBe('·······: ·····@·····.··')
  })

  test('is deterministic — same input produces same output', () => {
    const text = 'My API key is sk-abc123def456'
    expect(obfuscateText(text)).toBe(obfuscateText(text))
  })

  test('handles empty string', () => {
    expect(obfuscateText('')).toBe('')
  })

  test('obfuscates accented Latin characters (é, ñ, ü, ç, ö)', () => {
    expect(obfuscateText('contraseña')).toBe('··········')
    expect(obfuscateText('café')).toBe('····')
    expect(obfuscateText('Übermensch')).toBe('··········')
  })

  test('obfuscates CJK characters (Chinese, Japanese, Korean)', () => {
    expect(obfuscateText('日本語')).toBe('···')
    expect(obfuscateText('한국어')).toBe('···')
    expect(obfuscateText('中文')).toBe('··')
  })

  test('obfuscates Cyrillic characters', () => {
    expect(obfuscateText('Русский')).toBe('·······')
    expect(obfuscateText('пароль')).toBe('······')
  })

  test('obfuscates Arabic and Hebrew characters', () => {
    expect(obfuscateText('العربية')).toBe('·······')
    expect(obfuscateText('עברית')).toBe('·····')
  })

  test('obfuscates mixed scripts while preserving Markdown and punctuation', () => {
    const text = 'La contraseña es ski123 — 日本語 текст'
    const result = obfuscateText(text)
    // No letters or numbers of any script remain
    expect(result).not.toMatch(/[\p{L}\p{N}]/u)
    // Markdown/punctuation preserved
    expect(result).toContain('—')
    expect(result).toContain(' ')
  })
})

describe('redactMessageForViewer (single message)', () => {
  test('owner sees full content for a redacted message', () => {
    const msg = makeRedactedMessage()
    const result = redactMessageForViewer(msg, true)
    expect(result.content).toEqual({ type: 'text', text: SECRET_TEXT })
    expect(result.redactedPlaceholder).toBeUndefined()
  })

  test('non-owner sees obfuscated content for a redacted message', () => {
    const msg = makeRedactedMessage()
    const result = redactMessageForViewer(msg, false)
    expect(result.content).not.toBeNull()
    expect(result.content!.type).toBe('text')
    expect(result.content!.text).not.toMatch(/[\p{L}\p{N}]/u)
    expect(result.content!.text).toBe(obfuscateText(SECRET_TEXT))
    expect(result.redactedPlaceholder).toBeDefined()
    expect(result.redactedPlaceholder!.type).toBe('redacted')
  })

  test('non-owner sees content for a non-redacted message', () => {
    const msg = makeMessage()
    const result = redactMessageForViewer(msg, false)
    expect(result.content).toEqual({ type: 'text', text: SECRET_TEXT })
    expect(result.redactedPlaceholder).toBeUndefined()
  })
})
