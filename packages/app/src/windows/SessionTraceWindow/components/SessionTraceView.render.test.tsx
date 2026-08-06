import { fireEvent } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type {
  LatitudeSignalBadge,
  SessionTrace,
  TraceChild,
  TraceEvent,
  TraceLlmCall,
  TraceSession,
  TraceToolCall,
} from "../../../services/AdminApi"
import { renderWithTamagui } from "../../../test/renderWithTamagui"
import { SessionTraceView } from "./SessionTraceView"

const session = (over: Partial<TraceSession> = {}): TraceSession =>
  ({
    sessionUsageId: "su_1",
    agentId: "ag_neo",
    provider: "teros",
    actualProvider: "fireworks",
    modelId: "accounts/fireworks/models/kimi-k2p6",
    status: "completed",
    triggerKind: "user_message",
    durationMs: 4200,
    totalTokens: 1500,
    costUsd: 0.0021,
    llmCallCount: 2,
    toolCallCount: 1,
    ...over,
  }) as TraceSession

const llmEvent = (over: Partial<TraceLlmCall> = {}): TraceEvent => ({
  kind: "llm",
  at: "2026-06-30T10:00:00.000Z",
  llm: {
    usageId: "u1",
    step: 0,
    provider: "teros",
    actualProvider: "fireworks",
    modelId: "accounts/fireworks/models/kimi-k2p6",
    promptTokens: 100,
    completionTokens: 40,
    totalTokens: 140,
    costTotal: 0.001,
    messageId: "m1",
    message: { id: "m1", role: "assistant", createdAt: 1000, text: "hi", contentType: "text" },
    feedback: null,
    ...over,
  },
})

const toolEvent = (over: Partial<TraceToolCall> = {}): TraceEvent => ({
  kind: "tool",
  at: "2026-06-30T10:00:01.000Z",
  tool: {
    toolExecutionId: "t1",
    stepIndex: 0,
    toolCallIndex: 0,
    toolName: "bash",
    status: "success",
    durationMs: 120,
    ...over,
  },
})

const child = (over: Partial<TraceChild> = {}): TraceChild =>
  ({
    sessionUsageId: "su_child",
    agentId: "ag_helper",
    triggerKind: "delegation",
    status: "completed",
    modelId: "kimi",
    totalTokens: 200,
    costUsd: 0.0003,
    startedAt: "2026-06-30T10:00:00.500Z",
    durationMs: 800,
    ...over,
  }) as TraceChild

const signal = (over: Partial<LatitudeSignalBadge> = {}): LatitudeSignalBadge => ({
  slug: "custom-tool-calls-return-generic-tool-error",
  name: "Tool calls return a generic error",
  priority: "high",
  source: "signal.discovered",
  deepLinkUrl: "https://latitude.local/signals/abc",
  trigger: "signal.discovered",
  ...over,
})

const trace = (over: Partial<SessionTrace> = {}): SessionTrace => ({
  session: session(),
  events: [],
  children: [],
  ...over,
})

describe("SessionTraceView (F2)", () => {
  it("renders the session header with agent, model and status", () => {
    const { getByText } = renderWithTamagui(<SessionTraceView trace={trace()} />)
    expect(getByText("ag_neo")).toBeTruthy()
    // provider·model collapses the fireworks path to the bare model.
    expect(getByText("fireworks·kimi-k2p6")).toBeTruthy()
    expect(getByText("completed")).toBeTruthy()
  })

  it("renders the interleaved timeline: both an LLM call and a tool execution", () => {
    const { getByText } = renderWithTamagui(
      <SessionTraceView trace={trace({ events: [llmEvent(), toolEvent()] })} />,
    )
    expect(getByText("Timeline · 2 events")).toBeTruthy()
    expect(getByText("bash")).toBeTruthy() // the tool
    // The tool's duration (120ms) is printed next to its proportional bar.
    expect(getByText("120ms")).toBeTruthy()
  })

  it("shows the empty-timeline message when a turn has no events", () => {
    const { getByText } = renderWithTamagui(<SessionTraceView trace={trace()} />)
    expect(getByText("No LLM calls or tool executions recorded for this turn.")).toBeTruthy()
  })

  it("surfaces 👍/👎 feedback on a call", () => {
    const t = trace({
      events: [llmEvent({ feedback: { rating: "down", comment: "wrong" } })],
    })
    const { getByText } = renderWithTamagui(<SessionTraceView trace={t} />)
    expect(getByText('👎 "wrong"')).toBeTruthy()
  })

  it("renders subagents and wires their click when onOpenChild is given", () => {
    const onOpenChild = vi.fn()
    const t = trace({ children: [child()] })
    const { getByText, getByLabelText } = renderWithTamagui(
      <SessionTraceView trace={t} onOpenChild={onOpenChild} />,
    )
    expect(getByText("Subagents · 1")).toBeTruthy()
    expect(getByText("ag_helper")).toBeTruthy()
    // The row advertises itself as an opener (aria), so a list can navigate into it.
    expect(getByLabelText("Open subagent trace su_child")).toBeTruthy()
  })
})

describe("resolved names (P6, 2026-07-07 audit)", () => {
  it("renders the backend-resolved agent/user/workspace names when present", () => {
    const { getByText, queryByText } = renderWithTamagui(
      <SessionTraceView
        trace={trace({ agentName: "Neo", userName: "Antonio", workspaceName: "Teros HQ", children: [child({ agentName: "Helper Bot" })] })}
        onOpenChild={() => {}}
      />,
    )
    expect(getByText("Neo")).toBeTruthy()
    expect(getByText("Antonio · Teros HQ")).toBeTruthy()
    expect(getByText("Helper Bot")).toBeTruthy()
    // The resolved name REPLACES the raw id in the header/child rows.
    expect(queryByText("ag_neo")).toBeNull()
    expect(queryByText("ag_helper")).toBeNull()
  })

  it("falls back honestly to the raw ids when names are absent", () => {
    const { getByText } = renderWithTamagui(
      <SessionTraceView trace={trace({ children: [child()] })} onOpenChild={() => {}} />,
    )
    expect(getByText("ag_neo")).toBeTruthy()
    expect(getByText("ag_helper")).toBeTruthy()
  })
})

describe("SessionTraceView — Latitude signal badge (F4·C1)", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("renders the badge (name + priority) when the trace carries a signal", () => {
    const { getByText } = renderWithTamagui(
      <SessionTraceView trace={trace({ latitudeSignal: signal() })} />,
    )
    expect(getByText("Known signal")).toBeTruthy()
    expect(getByText("Tool calls return a generic error")).toBeTruthy()
    expect(getByText("high")).toBeTruthy()
  })

  it("renders NOTHING when there is no signal (Latitude down → view identical)", () => {
    const { queryByText } = renderWithTamagui(<SessionTraceView trace={trace()} />)
    expect(queryByText("Known signal")).toBeNull()
  })

  it("still renders the badge when priority is null (no priority chip)", () => {
    const { getByText, queryByText } = renderWithTamagui(
      <SessionTraceView trace={trace({ latitudeSignal: signal({ priority: null }) })} />,
    )
    expect(getByText("Known signal")).toBeTruthy()
    expect(queryByText("high")).toBeNull()
  })

  it("deep-links into Latitude on press", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null)
    const { getByText } = renderWithTamagui(
      <SessionTraceView
        trace={trace({ latitudeSignal: signal({ deepLinkUrl: "https://latitude.local/signals/xyz" }) })}
      />,
    )
    fireEvent.click(getByText("Tool calls return a generic error"))
    expect(open).toHaveBeenCalledWith(
      "https://latitude.local/signals/xyz",
      "_blank",
      "noopener,noreferrer",
    )
  })
})
