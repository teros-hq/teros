/**
 * TER-650/G2 — a task that autoplay re-wakes too many times WITHOUT progressing is
 * moved to the `blocked` column instead of spawning autonomous turns (and billing)
 * forever.
 *
 * Root cause of the phantom-session loop: the cron re-woke a stuck task every ~60s
 * indefinitely. The fix (autoplay-service.ts `_rewakeTask`) keeps a counter
 * `tasks.autoWakeCount` (reset to 0 by moveTask/addProgressNote, NOT by setRunning);
 * on reaching `config.autoplay.autoWakeCap` (default 5) it calls `_blockStuckTask`,
 * which moves the task to the `slug:'blocked'` column with an activity entry
 * `reason:'auto_wakes_exhausted'` (autoplay-service.ts:442-485).
 *
 * The pure logic lives in autoplay-service.test.ts (`_rewakeTask`, 3 cases). This
 * smoke validates the WIRING: board.set-agent-play → scheduleAgentTasks → re-wake scan
 * → _blockStuckTask → column in Mongo. Deterministic: we seed the stuck task AT the cap
 * (autoWakeCount=5) and a single scheduler pass blocks it — without waiting 5 wakes.
 *
 * The assertion is the column DB-probe (NOT waitForEvent): the `task.auto_wakes_exhausted`
 * notification travels through the scheduled-event path to `originChannelId`, not as a
 * WS push with that `type`.
 *
 * Mutation check: reverting G2 (dropping the `count >= cap` guard in _rewakeTask) → the
 * task is re-woken and increments to 6, STAYS in `in_progress` → never reaches `blocked`
 * → `waitForTaskColumn` returns null → red.
 */
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import {
  type ColumnLite,
  columnIdBySlug,
  seedStuckTaskAtCap,
  waitForTaskColumn,
} from "../helpers/board"
import { closeDb } from "../helpers/db"
import { evalTeros, getPrimaryIds, wsRequest } from "../helpers/teros"

const AUTO_WAKE_CAP = 5 // config.autoplay.autoWakeCap default (config.ts:189)

test.afterAll(async () => {
  await closeDb()
})

function createChannel(page: Page, agentId: string, workspaceId: string): Promise<string> {
  return evalTeros(
    page,
    ({ aid, wid }) =>
      window.teros.channel.create({ agentId: aid, workspaceId: wid }).then((r) => r.channelId),
    { aid: agentId, wid: workspaceId },
  )
}

function closeChannel(page: Page, channelId: string): Promise<unknown> {
  return evalTeros(page, (id) => window.teros.channel.close(id).catch(() => null), channelId)
}

test.describe("autoplay auto-wake cap (TER-650/G2) @usage", () => {
  test("a stuck task at the cap is moved to the 'blocked' column", async ({ terosPage }) => {
    test.setTimeout(90_000)
    const { agentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    expect(agentId, "user1 agentId").toBeTruthy()
    const wid = privateWorkspaceId as string

    const { projectId, columns } = await evalTeros(
      terosPage,
      async (workspaceId) => {
        const { project, board } = await window.teros.board.createProject(
          workspaceId,
          `Cap ${Date.now()}`,
        )
        return { projectId: project.projectId, columns: (board.columns ?? []) as ColumnLite[] }
      },
      wid,
    )
    const inProgressColumnId = columnIdBySlug(columns, "in_progress")
    const blockedColumnId = columnIdBySlug(columns, "blocked")

    // Real channel to populate the stuck task's channelId/originChannelId (the re-wake
    // scan filters on an existing channelId; _blockStuckTask does not dereference it).
    const channelId = await createChannel(terosPage, agentId as string, wid)
    const taskId = await seedStuckTaskAtCap(terosPage, {
      projectId,
      inProgressColumnId,
      agentId: agentId as string,
      channelId,
      autoWakeCount: AUTO_WAKE_CAP,
    })

    try {
      // Enabling autoplay fires ONE scheduleAgentTasks pass: the re-wake scan sees the
      // stuck task, _rewakeTask detects count>=cap → _blockStuckTask.
      await wsRequest(terosPage, "board.set-agent-slots", { projectId, agentId, slots: 1 })
      await wsRequest(terosPage, "board.set-agent-play", { projectId, agentId, enabled: true })

      const task = await waitForTaskColumn(taskId, blockedColumnId, { timeoutMs: 30_000 })
      expect(task, "the stuck task at the cap is moved to 'blocked'").not.toBeNull()
      expect(task?.columnId, "destination column = blocked").toBe(blockedColumnId)
      // Anti-false-green guard: without the fix it would stay in in_progress (count 6), never blocked.
      expect(task?.columnId, "did not stay in in_progress").not.toBe(inProgressColumnId)

      // The activity entry documents the automatic block on wake exhaustion. Found with
      // `find` (not the last entry): the `auto_wakes_exhausted` notification wakes the
      // supervising channel (wakeUpAgent:true), whose turn may push more activity — and
      // re-mark `running` — AFTER the block; so `running` is NOT a stable G2 invariant and
      // is not asserted. G2's invariants are the column + the activity.
      const activity = (task?.activity ?? []) as Array<{
        actor?: string
        details?: { reason?: string }
      }>
      const blockEntry = activity.find((a) => a.details?.reason === "auto_wakes_exhausted")
      expect(blockEntry, "there is an activity entry with reason=auto_wakes_exhausted").toBeTruthy()
      expect(blockEntry?.actor, "block actor = system:autoplay").toBe("system:autoplay")
    } finally {
      await wsRequest(terosPage, "board.set-agent-play", {
        projectId,
        agentId,
        enabled: false,
      }).catch(() => null)
      await evalTeros(
        terosPage,
        (pid) => window.teros.board.deleteProject(pid).catch(() => null),
        projectId,
      )
      await closeChannel(terosPage, channelId)
    }
  })
})
