/**
 * Render test for the Runn renderer (TER-635).
 *
 * Mordedura: the header text is composed from the imperative TOOL_LABELS via
 * `inferTenseForms`/`tenseByStatus`. If a label regresses to a noun (e.g.
 * "Projects"), the composer produces "Projectsed" and these asserts fail — that
 * is the exact bug class this test guards. We also assert the health verdict is
 * parsed into the header badge, and that the defensive `{ structuredContent }`
 * wrapper is tolerated. The expanded body (EntityRows / DualEntity) is validated
 * by the live smoke — it is collapsed by default here.
 */

import { describe, expect, it } from "vitest"
import { renderWithTamagui } from "../../../test/renderWithTamagui"
import type { ToolCallRendererProps } from "../types"
import { RunnToolCallRenderer } from "./RunnRenderer"

/** Production output: the backend serializes the handler's plain data object. */
function out(data: unknown): string {
  return JSON.stringify(data)
}

/** Legacy `{ content, structuredContent }` envelope — must be tolerated. */
function wrapped(structuredContent: unknown): string {
  return JSON.stringify({
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  })
}

function renderTool(props: Partial<ToolCallRendererProps>) {
  return renderWithTamagui(
    <RunnToolCallRenderer
      toolCallId="tc1"
      toolName={props.toolName ?? "runn-list-projects"}
      status={props.status ?? "completed"}
      {...props}
    />,
  )
}

describe("RunnRenderer — header tense composition", () => {
  it("list-projects (plain output) composes the past tense", () => {
    const { getByText } = renderTool({
      toolName: "runn-list-projects",
      status: "completed",
      output: out({
        items: [{ id: 1, name: "Apollo" }],
        total: 1,
        hasMore: false,
        nextCursor: null,
      }),
    })
    expect(getByText("Listed projects")).toBeTruthy()
  })

  it("list-projects tolerates the legacy { structuredContent } wrapper", () => {
    const { getByText } = renderTool({
      toolName: "runn-list-projects",
      status: "completed",
      output: wrapped({ items: [{ id: 1, name: "Apollo" }], total: 1 }),
    })
    expect(getByText("Listed projects")).toBeTruthy()
  })

  it("list-projects with a clientId filter shows the contextual description", () => {
    const { getByText } = renderTool({
      toolName: "runn-list-projects",
      status: "completed",
      input: { clientId: 5 },
      output: out({ items: [], total: 0, hasMore: false, nextCursor: null }),
    })
    expect(getByText("Projects (client #5)")).toBeTruthy()
  })

  it('create-project composes "Created project"', () => {
    const { getByText } = renderTool({
      toolName: "runn-create-project",
      status: "completed",
      output: out({ id: 9, name: "Apollo", clientId: 5 }),
    })
    expect(getByText("Created project")).toBeTruthy()
  })

  it('update-project composes "Updated project"', () => {
    const { getByText } = renderTool({
      toolName: "runn-update-project",
      status: "completed",
      input: { projectId: 9, name: "Apollo 2" },
      output: out({ id: 9, name: "Apollo 2" }),
    })
    expect(getByText("Updated project")).toBeTruthy()
  })

  it('create-assignment composes "Created assignment"', () => {
    const { getByText } = renderTool({
      toolName: "runn-create-assignment",
      status: "completed",
      input: {
        personId: 5,
        projectId: 12,
        roleId: 3,
        startDate: "2026-07-01",
        endDate: "2026-07-31",
        minutesPerDay: 480,
      },
      output: out({
        id: 77,
        personId: 5,
        projectId: 12,
        roleId: 3,
        minutesPerDay: 480,
        isBillable: true,
      }),
    })
    expect(getByText("Created assignment")).toBeTruthy()
  })

  it('delete-assignment composes "Deleted assignment"', () => {
    const { getByText } = renderTool({
      toolName: "runn-delete-assignment",
      status: "completed",
      input: { assignmentId: 77 },
      output: out({ success: true, assignmentId: 77 }),
    })
    expect(getByText("Deleted assignment")).toBeTruthy()
  })

  it("get-project running shows present tense, no crash without output", () => {
    const { getByText } = renderTool({ toolName: "runn-get-project", status: "running" })
    expect(getByText(/Getting project/)).toBeTruthy()
  })

  it("get-project failed composes the failure tense", () => {
    const { getByText } = renderTool({
      toolName: "runn-get-project",
      status: "failed",
      input: { projectId: 9 },
      error: "boom",
    })
    expect(getByText(/Failed to get project/)).toBeTruthy()
  })

  it('get-project pending_permission composes "Wants to get project"', () => {
    const { getByText } = renderTool({
      toolName: "runn-get-project",
      status: "pending_permission",
      input: { projectId: 9 },
    })
    expect(getByText(/Wants to get project/)).toBeTruthy()
  })
})

describe("RunnRenderer — health check", () => {
  it("shows a healthy badge when status is ready and no issues", () => {
    const { getByText } = renderTool({
      toolName: "-health-check",
      status: "completed",
      output: out({ status: "ready", version: "1.0.0" }),
    })
    expect(getByText("healthy")).toBeTruthy()
  })

  it("shows a degraded badge when the result reports issues", () => {
    const { getByText } = renderTool({
      toolName: "-health-check",
      status: "completed",
      output: out({
        status: "not_ready",
        issues: [{ code: "AUTH_INVALID", message: "bad token" }],
      }),
    })
    expect(getByText("degraded")).toBeTruthy()
  })
})
