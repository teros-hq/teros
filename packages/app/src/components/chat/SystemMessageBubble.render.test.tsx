import { marked } from 'marked'
import { describe, expect, it, vi } from 'vitest'
import { renderHtmlSpy } from '../../test/reactNativeRenderHtmlStub'
import { renderWithTamagui } from '../../test/renderWithTamagui'
import type { Message } from '../../store/chatStore'

// Capture references for use inside the mock factory.
const spy = renderHtmlSpy
const parse = marked.parse

// Mock the bubbles barrel — only need MarkdownContent to verify marked→RenderHtml wiring.
vi.mock('./bubbles', () => ({
  MarkdownContent: ({ text }: { text: string }) => {
    spy.source = { html: parse(text) as string }
    return null
  },
}))

// Mock TerosLogo (imports react-native-svg which is Flow-typed)
vi.mock('../TerosLogo', () => ({
  TerosLogo: () => null,
}))

const { SystemMessageBubble } = await import('./SystemMessageBubble')

function makeSystemMessage(text: string): Message {
  return {
    id: 'msg_sys',
    channelId: 'ch_test',
    content: { type: 'text', text },
    sender: 'system',
    timestamp: new Date('2026-01-15T10:30:00'),
  }
}

/**
 * SystemMessageBubble — now renders markdown via MarkdownContent.
 * Previously used a plain <Text> element; the refactor routes text through
 * marked → RenderHtml so system messages can contain formatting.
 */
describe('SystemMessageBubble — markdown rendering', () => {
  it('passes text through MarkdownContent (marked → RenderHtml)', () => {
    const msg = makeSystemMessage('Task **created** successfully')
    renderWithTamagui(<SystemMessageBubble message={msg} />)
    expect(renderHtmlSpy.source?.html).toBe(marked.parse('Task **created** successfully'))
    expect(renderHtmlSpy.source?.html).toContain('<strong>')
  })

  it('renders markdown links correctly', () => {
    const msg = makeSystemMessage('See [docs](https://teros.ai) for info')
    renderWithTamagui(<SystemMessageBubble message={msg} />)
    expect(renderHtmlSpy.source?.html).toContain('<a')
    expect(renderHtmlSpy.source?.html).toContain('href="https://teros.ai"')
  })

  it('renders code blocks correctly', () => {
    const msg = makeSystemMessage('```\nnpm run dev\n```')
    renderWithTamagui(<SystemMessageBubble message={msg} />)
    expect(renderHtmlSpy.source?.html).toContain('<pre>')
    expect(renderHtmlSpy.source?.html).toContain('<code>')
  })

  it('renders plain text without markdown syntax unchanged', () => {
    const msg = makeSystemMessage('Reminder: meeting at 3pm')
    renderWithTamagui(<SystemMessageBubble message={msg} />)
    expect(renderHtmlSpy.source?.html).toContain('Reminder: meeting at 3pm')
  })
})
