/**
 * Domain service for tool executions.
 *
 * Emits tool.started / tool.ended events. Computes inputSizeBytes and
 * outputSizeBytes via JSON.stringify when possible (best-effort: if the
 * input/output is not serializable, the field is omitted).
 *
 *
 */

import { generateToolExecutionId, generateUsageEventId } from "@teros/core"
import type {
  AgentUsageDurationSource,
  ToolExecutionStatus,
} from "../types/database.js"
import { sanitizeErrorMessage } from "./agent-usage-pii-sanitizer.js"
import type { UsageEventBuffer } from "./usage-event-buffer.js"

export interface ToolExecutionHandle {
  toolExecutionId: string
  monoStart: number
  wallStart: Date
}

export interface StartToolInput {
  sessionUsageId: string
  channelId: string
  userId: string
  agentId: string
  workspaceId: string
  stepIndex: number
  /** Always 0 today (sequential). Reserved for future parallel tool calls. */
  toolCallIndex: number
  toolName: string
  mcaId?: string
  /** Tool input — used to compute inputSizeBytes. */
  input?: unknown
}

export interface EndToolInput {
  sessionUsageId: string
  handle: ToolExecutionHandle
  status: Exclude<ToolExecutionStatus, "running">
  errorMessage?: unknown
  durationSource?: AgentUsageDurationSource
  /** Tool output — used to compute outputSizeBytes. */
  output?: unknown
}

export class ToolExecutionService {
  constructor(private readonly buffer: UsageEventBuffer) {}

  start(input: StartToolInput): ToolExecutionHandle {
    const toolExecutionId = generateToolExecutionId()
    const monoStart = performance.now()
    const wallStart = new Date()

    this.buffer.emit({
      eventId: generateUsageEventId(),
      sessionUsageId: input.sessionUsageId,
      toolExecutionId,
      type: "tool.started",
      payload: {
        channelId: input.channelId,
        userId: input.userId,
        agentId: input.agentId,
        workspaceId: input.workspaceId,
        stepIndex: input.stepIndex,
        toolCallIndex: input.toolCallIndex,
        toolName: input.toolName,
        mcaId: input.mcaId,
        startedAt: wallStart,
        inputSizeBytes: safeByteLength(input.input),
      },
      appliedAt: wallStart,
      schemaVersion: 1,
    })

    return { toolExecutionId, monoStart, wallStart }
  }

  end(input: EndToolInput): void {
    const { handle } = input
    const endedAt = new Date()
    const monoEnd = performance.now()
    const durationMs = Math.max(0, Math.round(monoEnd - handle.monoStart))
    const errorMessage = sanitizeErrorMessage(input.errorMessage)

    this.buffer.emit({
      eventId: generateUsageEventId(),
      sessionUsageId: input.sessionUsageId,
      toolExecutionId: handle.toolExecutionId,
      type: "tool.ended",
      payload: {
        endedAt,
        durationMs,
        durationSource: input.durationSource ?? "monotonic",
        status: input.status,
        ...(errorMessage ? { errorMessage } : {}),
        outputSizeBytes: safeByteLength(input.output),
      },
      appliedAt: endedAt,
      schemaVersion: 1,
    })
  }
}

/**
 * Compute UTF-8 byte length of a value, JSON-stringifying when needed.
 * Returns undefined if the value cannot be serialized (caller persists no
 * field). Best-effort, used for analytics not security.
 */
function safeByteLength(value: unknown): number | undefined {
  if (value === undefined) return undefined
  try {
    const str = typeof value === "string" ? value : JSON.stringify(value)
    if (str === undefined) return undefined
    return Buffer.byteLength(str, "utf8")
  } catch {
    return undefined
  }
}
