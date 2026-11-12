/**
 * WS2 render tests — the four agent-hours surfaces all paint the SAME
 * formatted duration ("2.3h") from the SAME data path
 * (useChannelAgentHours → user-api.my-usage-channels-summary):
 *
 *   1. ChatHeader chip            (testID "chat-agent-hours")
 *   2. Conversations row          (secondary line "· 2.3h")
 *   3. TaskCard mini badge        (testID "task-card-agent-hours-<taskId>")
 *   4. TaskDetailPanel meta row   (testID "task-detail-agent-hours")
 *
 * The hook is mocked per-suite (deterministic, no transport); its own caching
 * behavior is covered by the shared formatter + backend endpoint tests.
 *
 *   cd packages/app && npx vitest run src/__tests__/ws2-agent-hours-surfaces.render.test.tsx
 */
import { describe, expect, it, vi } from "vitest"
import { renderWithTamagui } from "../test/renderWithTamagui"

// ─── Mock the shared hook (the ONE data path for all surfaces) ──────────────
const hookMock = vi.hoisted(() => ({
  useChannelAgentHours: vi.fn(() => ({
    workMs: 8_400_000, // 2.3h
    sessions: 7,
    formatted: "2.3h",
    loading: false,
  })),
  useChannelsAgentHours: vi.fn(() => ({
    byChannel: {
      ch_1: { workMs: 8_400_000, sessions: 7 },
      ch_2: { workMs: 1_800_000, sessions: 2 }, // 30 m
    },
    loading: false,
  })),
}))
vi.mock("../hooks/useChannelAgentHours", () => hookMock)

// ─── 1. ChatHeader ───────────────────────────────────────────────────────────
describe("WS2 surface 1 — ChatHeader agent-hours chip", () => {
  it("renders the clock chip with the formatted duration", async () => {
    const { ChatHeader } = await import("../components/chat/ChatHeader")
    const { getByTestId } = renderWithTamagui(
      <ChatHeader title="Conv" agentName="Nira" agentHours="2.3h" />,
    )
    // jsdom: assert on rendered DOM text, not RN props.
    expect(getByTestId("chat-agent-hours").textContent).toContain("2.3h")
  })

  it("hides the chip when agentHours is null (loading / no channel)", async () => {
    const { ChatHeader } = await import("../components/chat/ChatHeader")
    const { queryByTestId } = renderWithTamagui(
      <ChatHeader title="Conv" agentName="Nira" agentHours={null} />,
    )
    expect(queryByTestId("chat-agent-hours")).toBeNull()
  })
})

// ─── 2. ConversationsWindow row ──────────────────────────────────────────────
describe("WS2 surface 2 — ConversationItem secondary line", () => {
  it("renders '· 2.3h' in the secondary line when agentHours is set", async () => {
    const { ConversationItem } = await import(
      "../windows/ConversationsWindow/ConversationsWindowContent"
    )
    const conv = makeConv("ch_1")
    const { getByTestId } = renderWithTamagui(
      <ConversationItem conv={conv} formatDate={() => "1/1"} onSelect={() => {}} agentHours="2.3h" />,
    )
    // The testID sits on the agent-name/preview <T> line; agentHours paints
    // right after the agent name: "Nira · 2.3h · hi".
    expect(getByTestId("conversation-agent-hours-ch_1").textContent).toContain("2.3h")
  })

  it("omits the duration when agentHours is null", async () => {
    const { ConversationItem } = await import(
      "../windows/ConversationsWindow/ConversationsWindowContent"
    )
    const conv = makeConv("ch_9")
    const { getByTestId } = renderWithTamagui(
      <ConversationItem conv={conv} formatDate={() => "1/1"} onSelect={() => {}} agentHours={null} />,
    )
    // The line still renders (agent name + preview) but WITHOUT the hours.
    expect(getByTestId("conversation-agent-hours-ch_9").textContent).not.toContain("2.3h")
  })
})

// ─── 3. TaskCard ─────────────────────────────────────────────────────────────
describe("WS2 surface 3 — TaskCard mini badge", () => {
  it("renders the badge under the title when the task has a linked channel", async () => {
    const { TaskCard } = await import("../windows/BoardWindow/TaskCard")
    const task = makeTask({ taskId: "t1", channelId: "ch_1" })
    const { getByTestId } = renderWithTamagui(
      <TaskCard
        task={task}
        isSelected={false}
        allColumns={[]}
        allTasks={[]}
        currentColumnSlug="todo"
        onPress={() => {}}
        onMoveTask={() => {}}
        onDeleteTask={() => {}}
        onOpenConversation={() => {}}
        agentMap={{}}
      />,
    )
    // jsdom: assert on rendered DOM text, not RN props.
    expect(getByTestId("task-card-agent-hours-t1").textContent).toContain("2.3h")
  })

  it("hides the badge for tasks without a linked channel", async () => {
    const { TaskCard } = await import("../windows/BoardWindow/TaskCard")
    const task = makeTask({ taskId: "t2", channelId: undefined })
    const { queryByTestId } = renderWithTamagui(
      <TaskCard
        task={task}
        isSelected={false}
        allColumns={[]}
        allTasks={[]}
        currentColumnSlug="todo"
        onPress={() => {}}
        onMoveTask={() => {}}
        onDeleteTask={() => {}}
        onOpenConversation={() => {}}
        agentMap={{}}
      />,
    )
    expect(queryByTestId("task-card-agent-hours-t2")).toBeNull()
  })
})

// ─── 4. TaskDetailPanel ──────────────────────────────────────────────────────
describe("WS2 surface 4 — TaskDetailPanel 'Tiempo de agente' row", () => {
  it("renders the row with the formatted duration", async () => {
    const { TaskDetailPanel } = await import("../windows/BoardWindow/TaskDetailPanel")
    const task = makeTask({ taskId: "t1", channelId: "ch_1" })
    const { getByTestId } = renderWithTamagui(
      <TaskDetailPanel
        task={task}
        columns={[]}
        onClose={() => {}}
        onMoveTask={() => {}}
        onOpenConversation={() => {}}
        onAssignTask={() => {}}
        onStartTask={() => {}}
        onStopTask={() => {}}
        onCompleteTask={() => {}}
        onArchiveTask={() => {}}
        agentMap={{}}
      />,
    )
    const text = getByTestId("task-detail-agent-hours").textContent ?? ""
    expect(text).toContain("Tiempo de agente")
    expect(text).toContain("2.3h")
  })

  it("renders '—' when the task has no linked channel", async () => {
    const { TaskDetailPanel } = await import("../windows/BoardWindow/TaskDetailPanel")
    const task = makeTask({ taskId: "t2", channelId: undefined })
    const { getByTestId } = renderWithTamagui(
      <TaskDetailPanel
        task={task}
        columns={[]}
        onClose={() => {}}
        onMoveTask={() => {}}
        onOpenConversation={() => {}}
        onAssignTask={() => {}}
        onStartTask={() => {}}
        onStopTask={() => {}}
        onCompleteTask={() => {}}
        onArchiveTask={() => {}}
        agentMap={{}}
      />,
    )
    const text = getByTestId("task-detail-agent-hours").textContent ?? ""
    expect(text).toContain("—")
    expect(text).not.toContain("2.3h")
  })
})

// ─── helpers ─────────────────────────────────────────────────────────────────
import type { Task } from "../store/boardStore"
import type { Conversation } from "../windows/ConversationsWindow/ConversationsWindowContent"

function makeConv(channelId: string): Conversation {
  return {
    channelId,
    title: "Conv",
    agentId: "agent_1",
    agentName: "Nira",
    lastMessageAt: "2026-10-01T00:00:00Z",
    lastMessageContent: "hi",
    status: "active",
    unreadCount: 0,
    scope: "personal",
  } as Conversation
}

function makeTask(over: Partial<Task> = {}): Task {
  return {
    taskId: "t_default",
    boardId: "b1",
    columnId: "col1",
    position: 0,
    title: "Task",
    priority: "medium",
    archived: false,
    running: false,
    tags: [],
    dependencies: [],
    progressNotes: [],
    activity: [],
    createdBy: "user_1",
    createdAt: new Date("2026-10-01").toISOString(),
    updatedAt: new Date("2026-10-01").toISOString(),
    ...over,
  } as Task
}
