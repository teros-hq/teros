/**
 * Board actions wired to the WsRouter (TER-463 / #158). Two prod bugs produced a
 * SILENT `UNKNOWN_ACTION`:
 *   - `board.move-my-task` handler existed but was never registered → an agent
 *     moving its own Kanban task did nothing.
 *   - the frontend emitted `board.set-channel-project` while the handler was under
 *     `project.set-channel-project` → linking a channel to a project never saved.
 *
 * `project.set-channel-project` registration is already proven by security.spec
 * (a stranger gets FORBIDDEN "Not your channel", not UNKNOWN_ACTION). Here we cover
 * `board.move-my-task`: a positive happy-path (creates a task, assigns it to the
 * caller's agent, moves it via the WS action, asserts it landed in the target
 * column) PLUS a registration guard (a bogus task → NOT_FOUND, never UNKNOWN_ACTION).
 *
 * Mutation check: comment out `router.register('board.move-my-task', …)` in
 * handlers/domains/board/index.ts → the action resolves to UNKNOWN_ACTION → the
 * happy-path move stops landing (column unchanged) and the guard's code flips to
 * UNKNOWN_ACTION → both assertions go red.
 */
import { expect, test } from "../fixtures"
import { attemptAction, evalTeros, getPrimaryIds } from "../helpers/teros"

test.describe("board — acciones registradas (move-my-task) @infra", () => {
  test("board.move-my-task mueve la tarea propia del agente (registrada + funcional)", async ({
    terosPage,
  }) => {
    const { agentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    expect(agentId, "agentId de user1").toBeTruthy()
    expect(privateWorkspaceId, "privateWorkspaceId de user1").toBeTruthy()

    // Create a project (→ board with default columns), a task, assign it to the agent.
    const setup = await evalTeros(
      terosPage,
      async ({ wid, aid }) => {
        const { project, board } = await window.teros.board.createProject(wid, `Move ${Date.now()}`)
        const cols = board.columns ?? []
        const task = (
          await window.teros.board.createTask(project.projectId, { title: "Movable" })
        ).task
        await window.teros.board.assignTask(task.taskId, aid)
        return {
          projectId: project.projectId,
          taskId: task.taskId,
          fromColumnId: task.columnId,
          columns: cols.map((c) => c.columnId),
        }
      },
      { wid: privateWorkspaceId, aid: agentId },
    )
    expect(setup.columns.length, "el board tiene varias columnas").toBeGreaterThan(1)
    const targetColumnId = setup.columns.find((c) => c !== setup.fromColumnId) as string
    expect(targetColumnId, "hay una columna destino distinta de la origen").toBeTruthy()

    try {
      // Drive the exact WS action the frontend uses (BoardApi.ts:339).
      const moved = await attemptAction(terosPage, "board.move-my-task", {
        taskId: setup.taskId,
        columnId: targetColumnId,
        agentId,
      })
      expect(
        moved.code,
        "board.move-my-task NO debe ser UNKNOWN_ACTION (handler registrado)",
      ).not.toBe("UNKNOWN_ACTION")
      expect(moved.resolved, `la tarea propia se mueve (err: ${moved.message ?? "-"})`).toBe(true)

      // Confirm it actually landed in the target column (functional, not just routed).
      const landedColumn = await evalTeros(
        terosPage,
        async (projectId) => {
          const { tasks } = await window.teros.board.listTasks(projectId)
          return tasks[0]?.columnId ?? null
        },
        setup.projectId,
      )
      expect(landedColumn, "la tarea quedó en la columna destino").toBe(targetColumnId)
    } finally {
      await evalTeros(
        terosPage,
        (id) => window.teros.board.deleteProject(id).catch(() => null),
        setup.projectId,
      )
    }
  })

  test("board.move-my-task con tarea inexistente da NOT_FOUND, no UNKNOWN_ACTION", async ({
    terosPage,
  }) => {
    const { agentId } = await getPrimaryIds(terosPage)
    const r = await attemptAction(terosPage, "board.move-my-task", {
      taskId: "task_deadbeefdeadbeef",
      columnId: "col_deadbeefdeadbeef",
      agentId: agentId ?? "agent_x",
    })
    expect(r.resolved, "una tarea inexistente no resuelve").toBe(false)
    // The load-bearing assertion: the action is ROUTED (NOT_FOUND), not missing.
    expect(r.code, "acción registrada → NOT_FOUND, no UNKNOWN_ACTION").toBe("NOT_FOUND")
  })
})
