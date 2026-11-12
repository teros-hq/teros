import { describe, it, expect, vi } from "vitest"
import { Text } from "react-native"

// Mock i18n
vi.mock("../../i18n", () => ({
  getDateLocale: () => "en-US",
}))

// Mock useColors — the real dark token set (the bubble reads the OS roles:
// tint.i, bgStep, liftSm…), fixed to dark so assertions don't depend on theme.
vi.mock("../mca/primitives/useColors", async () => {
  const { surface, badges, categoryBadges } = await vi.importActual<any>("../mca/primitives/colors")
  return {
    useColors: () => ({
      ...surface.dark,
      badges: badges.dark,
      categoryBadges: categoryBadges.dark,
    }),
    useMcaTheme: () => "dark",
  }
})

vi.mock("../mca/primitives/colors", () => ({
  colors: {
    indigoDark: "#5E6AD2",
  },
}))

// Mock react-i18next
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: any) => {
      const defaults: Record<string, string> = {
        "conversations.redacted.protectedBy": "Protected by {{owner}}",
        "conversations.redacted.owner": "Owner",
        "conversations.redacted.redactedLabel": "Redacted",
        "conversations.redacted.unredact": "Un-redact",
        "conversations.redacted.clickToReveal": "Click to reveal",
        "conversations.redacted.clickToHide": "Click to hide",
        "conversations.redacted.emptyContent": "[Redacted content]",
      }
      let result = opts?.defaultValue || defaults[key] || key
      // Simple interpolation: replace {{var}} with opts values
      if (opts) {
        for (const [k, v] of Object.entries(opts)) {
          if (typeof v === "string" || typeof v === "number") {
            result = result.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), String(v))
          }
        }
      }
      return result
    },
  }),
}))

// Mock SelectableText and MarkdownContent from ./bubbles
vi.mock("./bubbles", () => ({
  SelectableText: ({ children }: { children: React.ReactNode }) => <Text>{children}</Text>,
  MarkdownContent: ({ text }: { text: string }) => <Text>{text}</Text>,
}))

import { renderWithTamagui } from "../../test/renderWithTamagui"
import { RedactedMessageBubble } from "./RedactedMessageBubble"
import type { Message } from "../../store/chatStore"

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg_001",
    channelId: "ch_test",
    content: { type: "text", text: "This is sensitive content" } as any,
    sender: "agent",
    timestamp: new Date("2026-09-14T12:00:00Z"),
    ...overrides,
  }
}

describe("RedactedMessageBubble", () => {
  describe("Owner view (isOwner=true)", () => {
    it("renders the redacted label and blurry content", () => {
      const message = makeMessage({ redacted: true })
      const { getByText } = renderWithTamagui(
        <RedactedMessageBubble message={message} isOwner={true} />,
      )

      // Should show "Redacted" label
      expect(getByText("Redacted")).toBeTruthy()

      // Should show the original content (blurred via CSS, but present in DOM)
      expect(getByText("This is sensitive content")).toBeTruthy()

      // Should show click-to-reveal hint
      expect(getByText("Click to reveal")).toBeTruthy()
    })

    it("shows Un-redact button when onToggleRedaction is provided", () => {
      const message = makeMessage({ redacted: true })
      const onToggle = vi.fn()
      const { getByText } = renderWithTamagui(
        <RedactedMessageBubble message={message} isOwner={true} onToggleRedaction={onToggle} />,
      )

      expect(getByText("Un-redact")).toBeTruthy()
    })

    it("does not show Un-redact button when onToggleRedaction is not provided", () => {
      const message = makeMessage({ redacted: true })
      const { queryByText } = renderWithTamagui(
        <RedactedMessageBubble message={message} isOwner={true} />,
      )

      expect(queryByText("Un-redact")).toBeNull()
    })
  })

  describe("Non-owner view (isOwner=false)", () => {
    it('renders "Protected by [owner]" placeholder with obfuscated content', () => {
      const message = makeMessage({
        redacted: true,
        content: { type: "text", text: "···· ········ ·······" } as any,
        redactedPlaceholder: {
          type: "redacted",
          reason: "protected_by_owner",
          originalAuthor: "user",
          originalTimestamp: "2026-09-14T12:00:00Z",
        },
      })
      const { container } = renderWithTamagui(
        <RedactedMessageBubble message={message} isOwner={false} ownerName="Alice" />,
      )

      // Should contain "Protected by Alice" text (may be split across elements)
      expect(container.textContent).toContain("Protected by Alice")
      // Should render the obfuscated content
      expect(container.textContent).toContain("···· ········ ·······")
    })

    it('uses "Owner" as fallback when ownerName is not provided', () => {
      const message = makeMessage({
        redacted: true,
        content: { type: "text", text: "···· ········ ·······" } as any,
        redactedPlaceholder: {
          type: "redacted",
          reason: "protected_by_owner",
          originalAuthor: "user",
          originalTimestamp: "2026-09-14T12:00:00Z",
        },
      })
      const { container } = renderWithTamagui(
        <RedactedMessageBubble message={message} isOwner={false} />,
      )

      expect(container.textContent).toContain("Protected by Owner")
    })

    it("does NOT render the original content (AC-6: content is obfuscated for non-owner)", () => {
      const message = makeMessage({
        redacted: true,
        content: { type: "text", text: "···· ········ ·······" } as any,
        redactedPlaceholder: {
          type: "redacted",
          reason: "protected_by_owner",
          originalAuthor: "user",
          originalTimestamp: "2026-09-14T12:00:00Z",
        },
      })
      const { queryByText } = renderWithTamagui(
        <RedactedMessageBubble message={message} isOwner={false} />,
      )

      // The original content must NOT be present — AC-6
      expect(queryByText("This is sensitive content")).toBeNull()
      // The obfuscated content IS present (rendered as Markdown)
      expect(queryByText("···· ········ ·······")).toBeTruthy()
    })

    it("does not show Un-redact button for non-owner", () => {
      const message = makeMessage({
        redacted: true,
        content: { type: "text", text: "···· ········ ·······" } as any,
        redactedPlaceholder: {
          type: "redacted",
          reason: "protected_by_owner",
          originalAuthor: "user",
          originalTimestamp: "2026-09-14T12:00:00Z",
        },
      })
      const onToggle = vi.fn()
      const { queryByText } = renderWithTamagui(
        <RedactedMessageBubble message={message} isOwner={false} onToggleRedaction={onToggle} />,
      )

      expect(queryByText("Un-redact")).toBeNull()
    })
  })
})
