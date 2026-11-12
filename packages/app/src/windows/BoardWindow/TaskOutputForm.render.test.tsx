/**
 * Regression test for the Rules-of-Hooks violation that took whole windows
 * down with "Error loading window content — Rendered more hooks than during
 * the previous render".
 *
 * TaskOutputFormInline used to early-return on signal gates BEFORE its
 * useMemo(structuredSchema)/useMemo(fields) calls. TaskDetailPanel renders it
 * without a key, so selecting task A (signal gate) then task B (structured or
 * markdown gate) re-used the same component instance with a different hook
 * count → React threw → the per-window ErrorBoundary showed
 * "Error loading window content".
 *
 * The fix hoists the memos above the early return. This test re-renders the
 * SAME instance through signal → structured → markdown → signal and asserts
 * nothing throws. With the old code it fails with exactly the React error
 * from the bug report.
 *
 * NOTE on rerender: RTL's rerender() replaces the WHOLE tree — the
 * TamaguiProvider wrapper from renderWithTamagui is not preserved, so every
 * rerender re-wraps it (otherwise useThemeName throws "Missing theme").
 *
 *   cd packages/app && npx vitest run src/windows/BoardWindow/TaskOutputForm.render.test.tsx
 */
import { describe, expect, it } from "vitest"
import { TamaguiProvider } from "tamagui"
import config from "../../../tamagui.config"
import "../../i18n"
import { renderWithTamagui } from "../../test/renderWithTamagui"
import { TaskOutputFormInline } from "./TaskOutputForm"
import type { Task } from "../../store/boardStore"

function makeTask(extra?: Partial<Task>): Task {
  return {
    taskId: "task_1",
    boardId: "board_1",
    columnId: "col_1",
    position: 0,
    title: "Fix the landing hero",
    priority: "medium",
    archived: false,
    running: false,
    tags: [],
    dependencies: [],
    createdBy: "user_1",
    createdAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-28T00:00:00.000Z",
    ...extra,
  } as Task
}

const SIGNAL_TASK = makeTask()
const MARKDOWN_TASK = makeTask()
const STRUCTURED_TASK = makeTask({
  output: {
    schemaId: "art_report",
    schema: {
      name: "Report",
      title: "Report",
      type: "object",
      properties: {
        summary: { name: "summary", type: "string", required: true, label: "Summary" },
      },
    },
  },
})

function inlineProps(task: Task, outputType: "signal" | "structured" | "markdown") {
  return {
    task,
    outputType,
    gate: null,
    markdownText: "",
    onMarkdownChange: () => {},
    fieldValues: {} as Record<string, string | boolean>,
    onFieldChange: () => {},
  }
}

describe("TaskOutputFormInline (Rules of Hooks regression)", () => {
  it("survives the output gate type changing between renders of the same instance", () => {
    // signal first — the branch that used to skip the memos entirely
    const r = renderWithTamagui(
      <TaskOutputFormInline {...inlineProps(SIGNAL_TASK, "signal")} />,
    )
    expect(r.getByText(/formulario de resultado/i)).toBeTruthy()

    // rerender() replaces the whole tree — re-wrap the provider each time
    const rerender = (ui: React.ReactElement) =>
      r.rerender(
        <TamaguiProvider config={config} defaultTheme="dark">
          {ui}
        </TamaguiProvider>,
      )

    // signal → structured: more hooks than the previous render (the throw)
    rerender(<TaskOutputFormInline {...inlineProps(STRUCTURED_TASK, "structured")} />)
    // structured → markdown: different branch, same instance again
    rerender(<TaskOutputFormInline {...inlineProps(MARKDOWN_TASK, "markdown")} />)
    // markdown → signal: fewer hooks — also must not throw
    rerender(<TaskOutputFormInline {...inlineProps(SIGNAL_TASK, "signal")} />)

    // The signal branch renders its "no form" copy — the instance is alive.
    expect(r.getByText(/formulario de resultado/i)).toBeTruthy()
  })
})
