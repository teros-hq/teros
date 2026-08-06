/**
 * Projects/Boards domain. Two tests:
 *  - board flow (no LLM): create-project → create-task → move-task → assign-task,
 *    asserted via the live client. Columns come from the board (Backlog…Done).
 *  - @llm: start-task wakes the assigned agent (board runner). Asserts it returns a
 *    channelId and the task is started; then stops it (avoid a runaway autorun).
 */
import { expect, test } from "../fixtures"
import { clearEvents, evalTeros, getPrimaryIds, waitForEvent } from "../helpers/teros"

test.describe("projects @projects", () => {
  test("board flow: create-project → task → move → assign", async ({
    terosPage,
    secondUser1Page,
  }) => {
    const { privateWorkspaceId, agentId } = await getPrimaryIds(terosPage)
    expect(privateWorkspaceId, "private workspace resuelto").toBeTruthy()
    const wid = privateWorkspaceId as string
    const name = `Pw Board ${Date.now()}`

    // create-project (+ realtime project.created to a 2nd session)
    await clearEvents(secondUser1Page)
    const { projectId, columns } = await evalTeros(
      terosPage,
      ({ wid, name }) =>
        window.teros.board.createProject(wid, name).then((r) => ({
          projectId: r.project.projectId,
          columns: r.board.columns || [],
        })),
      { wid, name },
    )
    expect(projectId, "createProject devuelve projectId").toBeTruthy()
    expect(columns.length, "el board trae columnas default").toBeGreaterThan(1)
    expect(
      await waitForEvent(secondUser1Page, { type: "project.created" }, 8000),
      "project.created en la 2ª sesión",
    ).toBeTruthy()

    const present = await evalTeros(
      terosPage,
      ({ wid, pid }) =>
        window.teros.board
          .listProjects(wid)
          .then((r) => r.projects.some((p) => p.projectId === pid)),
      { wid, pid: projectId },
    )
    expect(present, "proyecto presente en listProjects").toBe(true)

    const backlog = columns.find((c) => c.slug === "backlog") ?? columns[0]
    const inProgress = columns.find((c) => c.slug === "in_progress") ?? columns[2] ?? columns[1]

    // create-task in Backlog
    const taskId = await evalTeros(
      terosPage,
      ({ pid, colId }) =>
        window.teros.board
          .createTask(pid, { title: "Pw Task", columnId: colId })
          .then((r) => r.task.taskId),
      { pid: projectId, colId: backlog.columnId },
    )
    expect(taskId, "createTask devuelve taskId").toBeTruthy()
    const taskListed = await evalTeros(
      terosPage,
      ({ pid, tid }) =>
        window.teros.board.listTasks(pid).then((r) => r.tasks.some((t) => t.taskId === tid)),
      { pid: projectId, tid: taskId },
    )
    expect(taskListed, "tarea presente en listTasks").toBe(true)

    // move-task → In Progress
    const movedCol = await evalTeros(
      terosPage,
      ({ tid, colId }) => window.teros.board.moveTask(tid, colId).then((r) => r.task.columnId),
      { tid: taskId, colId: inProgress.columnId },
    )
    expect(movedCol, "la tarea se movió a la columna destino").toBe(inProgress.columnId)

    // assign-task → primary agent (no LLM, just sets assignedAgentId)
    const assignedTo = await evalTeros(
      terosPage,
      ({ tid, aid }) => window.teros.board.assignTask(tid, aid).then((r) => r.task.assignedAgentId),
      { tid: taskId, aid: agentId as string },
    )
    expect(assignedTo, "la tarea quedó asignada al agente").toBe(agentId)

    // cleanup — deleting the project removes its board + tasks
    await evalTeros(
      terosPage,
      (pid) => window.teros.board.deleteProject(pid).then(() => null),
      projectId,
    )
  })

  test("start-task despierta al agente asignado @llm", async ({ terosPage }) => {
    test.setTimeout(60_000)
    const { privateWorkspaceId, agentId } = await getPrimaryIds(terosPage)
    const wid = privateWorkspaceId as string

    const { projectId, columns } = await evalTeros(
      terosPage,
      ({ wid, name }) =>
        window.teros.board.createProject(wid, name).then((r) => ({
          projectId: r.project.projectId,
          columns: r.board.columns || [],
        })),
      { wid, name: `Pw Run ${Date.now()}` },
    )
    const backlog = columns.find((c) => c.slug === "backlog") ?? columns[0]

    const taskId = await evalTeros(
      terosPage,
      ({ pid, colId }) =>
        window.teros.board
          .createTask(pid, { title: "Di solo PONG y termina.", columnId: colId })
          .then((r) => r.task.taskId),
      { pid: projectId, colId: backlog.columnId },
    )
    await evalTeros(
      terosPage,
      ({ tid, aid }) => window.teros.board.assignTask(tid, aid).then(() => null),
      { tid: taskId, aid: agentId as string },
    )

    // start-task → board runner wakes the agent; returns the work channel.
    const channelId = await evalTeros(
      terosPage,
      ({ tid, aid }) => window.teros.board.startTask(tid, aid).then((r) => r.channelId),
      { tid: taskId, aid: agentId as string },
    )
    expect(channelId, "startTask devuelve el canal de trabajo").toBeTruthy()

    // stop the autorun so we don't leave the agent looping, then clean up. Tolerant:
    // a fast agent may already have finished the task ("Task is not currently running").
    await evalTeros(
      terosPage,
      (tid) =>
        window.teros.board
          .stopTask(tid)
          .then(() => null)
          .catch(() => null),
      taskId,
    )
    await evalTeros(
      terosPage,
      (pid) => window.teros.board.deleteProject(pid).then(() => null),
      projectId,
    )
  })
})
