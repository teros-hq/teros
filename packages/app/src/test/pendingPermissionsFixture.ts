/**
 * Test fixture shared by the navbar sheet and Pending approvals window render
 * tests (PERMW-AC-1, PERMW-AC-3): a fake WS client that records listeners and
 * the decision calls, plus the three pending requests of the acceptance
 * criteria — two of different apps in one conversation, one in another.
 */
import { vi } from "vitest"
import { useChatStore } from "../store/chatStore"

export class FakePermissionsClient {
  private listeners = new Map<string, Set<(d: unknown) => void>>()
  on(event: string, handler: (d: unknown) => void): void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(handler)
  }
  off(event: string, handler: (d: unknown) => void): void {
    this.listeners.get(event)?.delete(handler)
  }
  emit(event: string, data: unknown): void {
    for (const h of this.listeners.get(event) ?? []) h(data)
  }
  isConnected = () => true
  channel = {
    list: vi.fn(async () => ({ channels: [] })),
    subscribe: vi.fn(async () => {}),
    getMessages: vi.fn(async () => ({ messages: [] })),
  }
  app = {
    updateToolPermission: vi.fn(async () => {}),
    getToolDetails: vi.fn(async (appId: string) => ({ appId, mcaId: "", tools: [] })),
  }
  respondToToolPermission = vi.fn()
}

export const REQUESTS = [
  {
    requestId: "r1",
    channelId: "ch1",
    toolName: "hubspot_create-contact",
    appId: "app_hubspot",
    mcaId: "mca.test.hubspot",
    input: { email: "ana@example.com" },
    messageId: "msg1",
    toolCallId: "tc1",
    timestamp: 1,
  },
  {
    requestId: "r2",
    channelId: "ch1",
    toolName: "gmail_send-email",
    appId: "app_gmail",
    mcaId: "mca.test.gmail",
    irreversible: true,
    input: { to: "bob@example.com" },
    messageId: "msg2",
    toolCallId: "tc2",
    timestamp: 2,
  },
  {
    requestId: "r3",
    channelId: "ch2",
    toolName: "files-write",
    appId: "app_fs",
    mcaId: "mca.test.fs",
    input: { path: "/tmp/a" },
    messageId: "msg3",
    toolCallId: "tc3",
    timestamp: 3,
  },
]

/** The conversations the requests belong to, as the chat store knows them. */
export function seedChannels(): void {
  const base = {
    agentId: "agent_1",
    agentAvatarUrl: null,
    isTyping: false,
    isRenaming: false,
    isAutonaming: false,
    lastMessageAt: null,
    createdAt: "2026-10-28T00:00:00Z",
    updatedAt: "2026-10-28T00:00:00Z",
  }
  useChatStore.setState({
    channels: {
      ch1: { ...base, channelId: "ch1", title: "Sales follow-up", agentName: "Atlas" },
      ch2: { ...base, channelId: "ch2", title: "Release notes", agentName: "Iris" },
    },
  } as never)
}
