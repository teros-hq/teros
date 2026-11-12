import { marked } from "marked"
import { describe, expect, it, vi } from "vitest"
import { renderHtmlSpy } from "../../test/reactNativeRenderHtmlStub"
import { renderWithTamagui } from "../../test/renderWithTamagui"
import type { Message } from "../../store/chatStore"

// Capture references for use inside the mock factory.
// vi.mock is hoisted — the factory runs before top-level imports, so we
// can't reference outer `const` variables directly. Instead we use the
// spy object (mutable reference) and marked (already imported via ESM).
const spy = renderHtmlSpy
const parse = marked.parse

// Mock the bubbles barrel to avoid pulling in Flow-typed transitive deps
// (HtmlBubble → react-native-webview, VoiceBubble → TerosLoading → react-native-svg, etc.)
// We only need MarkdownContent to verify the marked→RenderHtml wiring.
vi.mock("./bubbles", () => ({
  MarkdownContent: ({ text }: { text: string }) => {
    spy.source = { html: parse(text) as string }
    return null
  },
  SelectableText: ({ children }: any) => null,
  useChatPane: () => ({ width: 1200, compact: false, narrow: false }),
  AudioBubble: () => null,
  FileBubble: () => null,
  ImageBubble: () => null,
  VoiceBubble: () => null,
}))

// Mock queuedDecorations (imports @tamagui/lucide-icons)
vi.mock("./queuedDecorations", () => ({
  QueuedIndicator: () => null,
  QueuedShimmer: () => null,
}))

// Mock Avatar (imports useImageWithFallback hook)
vi.mock("../Avatar", () => ({
  Avatar: () => null,
}))

// Mock authStore
vi.mock("../../store/authStore", () => ({
  useAuthStore: () => undefined,
}))

const { UserMessageBubble } = await import("./UserMessageBubble")

function makeTextMessage(text: string): Message {
  return {
    id: "msg_test",
    channelId: "ch_test",
    content: { type: "text", text },
    sender: "user",
    timestamp: new Date("2026-01-15T10:30:00"),
  }
}

/**
 * UserMessageBubble — markdown rendering via MarkdownContent.
 * The RenderHtml stub captures the parsed HTML, so we can assert that
 * markdown syntax (bold, lists, code) is correctly parsed and passed through.
 */
describe("UserMessageBubble — markdown rendering", () => {
  it("passes text through MarkdownContent (marked → RenderHtml)", () => {
    const msg = makeTextMessage("**bold text**")
    renderWithTamagui(<UserMessageBubble message={msg} />)
    expect(renderHtmlSpy.source?.html).toBe(marked.parse("**bold text**"))
    expect(renderHtmlSpy.source?.html).toContain("<strong>")
  })

  it("renders markdown lists correctly", () => {
    const msg = makeTextMessage("- item one\n- item two")
    renderWithTamagui(<UserMessageBubble message={msg} />)
    expect(renderHtmlSpy.source?.html).toContain("<ul>")
    expect(renderHtmlSpy.source?.html).toContain("<li>")
  })

  it("renders inline code correctly", () => {
    const msg = makeTextMessage("Use `npm install` to install")
    renderWithTamagui(<UserMessageBubble message={msg} />)
    expect(renderHtmlSpy.source?.html).toContain("<code>")
  })

  it("renders plain text without markdown syntax unchanged", () => {
    const msg = makeTextMessage("Hello world")
    renderWithTamagui(<UserMessageBubble message={msg} />)
    expect(renderHtmlSpy.source?.html).toContain("Hello world")
  })
})
