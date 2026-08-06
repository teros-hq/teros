/**
 * Board/autoplay helpers for the TER-650 autoplay specs (G2/G3). Board actions go
 * through the live client; task-state assertions + the stuck-task seed talk to Mongo
 * directly (the suite runs in the Playwright Node process, like helpers/usage.ts).
 *
 * Autoplay (`board.set-agent-play` / `board.set-agent-slots`) is a per-agent-per-project
 * relationship, NOT declared on `teros-global.d.ts`, so specs drive it via
 * `transport.request`. Columns carry a random `columnId` per board — the stable key
 * is the `slug` (board-service.ts DEFAULT_COLUMNS: backlog/todo/in_progress/blocked/review/done).
 */
import type { Page } from "@playwright/test"
import { getMongoDb } from "./db"

/** A board column as returned by createProject/getBoard. */
export interface ColumnLite {
  columnId: string
  slug: string
  name?: string
}

/** Resolve a column's (random) columnId by its stable slug. Throws if absent. */
export function columnIdBySlug(columns: ColumnLite[], slug: string): string {
  const col = columns.find((c) => c.slug === slug)
  if (!col)
    throw new Error(
      `board has no '${slug}' column (slugs: ${columns.map((c) => c.slug).join(",")})`,
    )
  return col.columnId
}

/** Read the owner of a workspace (G3 attributes autorun sessions to workspaces.ownerId). */
export async function getWorkspaceOwnerId(workspaceId: string): Promise<string | null> {
  const db = await getMongoDb()
  const ws = await db.collection("workspaces").findOne({ workspaceId })
  return (ws?.ownerId as string | undefined) ?? null
}

/** Read a task document (G2 asserts it landed in the blocked column). */
export async function getTaskById(taskId: string): Promise<Record<string, unknown> | null> {
  const db = await getMongoDb()
  return db.collection("tasks").findOne({ taskId })
}

/**
 * Poll until a task's `columnId` reaches `columnId` (the block is async after the
 * autoplay trigger). Returns the task once it lands there, or null on timeout.
 */
export async function waitForTaskColumn(
  taskId: string,
  columnId: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<Record<string, unknown> | null> {
  const { timeoutMs = 30_000, pollMs = 1000 } = opts
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const task = await getTaskById(taskId)
    if (task?.columnId === columnId) return task
    await new Promise((r) => setTimeout(r, pollMs))
  }
  return null
}

/**
 * Seed a "stuck" task already AT the auto-wake cap (G2): a valid task created via the
 * real `board.create-task` (so its shape never drifts from the Task type), landed in
 * the `in_progress` column, then DB-patched to the exact stuck state the re-wake scan
 * selects — `assignedAgentId` + `channelId` present + `running:false` + `autoWakeCount`.
 *
 * We patch instead of `assignTask` because `board.assign-task` would fire
 * `scheduleAgentTasks` prematurely (assign-task.ts:78); the direct patch sets the
 * atomic stuck state BEFORE any autoplay trigger. Returns the taskId.
 */
export async function seedStuckTaskAtCap(
  page: Page,
  opts: {
    projectId: string
    inProgressColumnId: string
    agentId: string
    channelId: string
    autoWakeCount: number
  },
): Promise<string> {
  const taskId = await page.evaluate(
    async ({ pid, col }) => {
      const r = await window.teros.board.createTask(pid, { title: "stuck task", columnId: col })
      return r.task.taskId
    },
    { pid: opts.projectId, col: opts.inProgressColumnId },
  )
  const db = await getMongoDb()
  await db.collection("tasks").updateOne(
    { taskId },
    {
      $set: {
        assignedAgentId: opts.agentId,
        channelId: opts.channelId,
        originChannelId: opts.channelId,
        running: false,
        autoWakeCount: opts.autoWakeCount,
        updatedAt: new Date().toISOString(),
      },
    },
  )
  return taskId
}
