/**
 * TER-650/G3 — an autoplay (autorun) turn is attributed to the workspace OWNER,
 * not to "system", and records the session with triggerKind='autorun'.
 *
 * The phantom-session incident stemmed from mis-attributed autonomous runs: autoplay
 * created the channel as 'system' and the session did not reflect its origin. The fix
 * (`_startNewTask`, autoplay-service.ts:487) resolves `workspaces.ownerId`, creates
 * the channel as the owner, and wakes with triggerKind='autorun'
 * (autoplay-service.ts:593). Fail-loud when there is no owner: no channel is created
 * (never bills 'system').
 *
 * The pure logic lives in autoplay-service.test.ts (`_startNewTask`, 3 cases). This
 * smoke validates the end-to-end WIRING: board.set-agent-play → AutoplayService →
 * ChannelManager → session in `agent_usage_sessions` (Mongo).
 *
 * Model-robust: the session is persisted at session.started (triggerKind + userId
 * fixed) BEFORE the LLM answers, so the assertion does not depend on the replay.
 *
 * Mutation check: reverting G3 (creating the channel as 'system' instead of
 * `workspaces.ownerId`) makes `session.userId !== ownerId` → red. Breaking the owner
 * resolution (fail-loud) prevents the channel from being created → no 'autorun'
 * session appears → `waitForUsageSessionByAgent` returns null → red.
 */
import type { Page } from "@playwright/test"
import { expect, test } from "../fixtures"
import { type ColumnLite, columnIdBySlug, getWorkspaceOwnerId } from "../helpers/board"
import { closeDb } from "../helpers/db"
import { ensureTerosProvider } from "../helpers/provider"
import { evalTeros, getPrimaryIds, wsRequest } from "../helpers/teros"
import { waitForUsageSessionByAgent } from "../helpers/usage"

test.afterAll(async () => {
  await closeDb()
})

function closeChannel(page: Page, channelId: string): Promise<unknown> {
  return evalTeros(page, (id) => window.teros.channel.close(id).catch(() => null), channelId)
}

test.describe("autoplay attribution (TER-650/G3) @usage", () => {
  test("an autoplay turn opens a triggerKind='autorun' session with userId=workspace.ownerId", async ({
    terosPage,
  }) => {
    test.setTimeout(120_000)
    const { agentId, privateWorkspaceId } = await getPrimaryIds(terosPage)
    expect(agentId, "user1 agentId").toBeTruthy()
    const wid = privateWorkspaceId as string
    await ensureTerosProvider(terosPage, agentId as string)

    const ownerId = await getWorkspaceOwnerId(wid)
    expect(ownerId, "the private workspace has an ownerId").toBeTruthy()

    // Create a project + an ELIGIBLE task (Todo column, assigned to the agent, no deps).
    const { projectId, columns } = await evalTeros(
      terosPage,
      async (workspaceId) => {
        const { project, board } = await window.teros.board.createProject(
          workspaceId,
          `Autorun ${Date.now()}`,
        )
        return { projectId: project.projectId, columns: (board.columns ?? []) as ColumnLite[] }
      },
      wid,
    )
    const todoColumnId = columnIdBySlug(columns, "todo")

    try {
      await evalTeros(
        terosPage,
        async ({ pid, col, aid }) => {
          const r = await window.teros.board.createTask(pid, {
            title: "autorun task",
            columnId: col,
          })
          await window.teros.board.assignTask(r.task.taskId, aid)
        },
        { pid: projectId, col: todoColumnId, aid: agentId },
      )

      await wsRequest(terosPage, "board.set-agent-slots", { projectId, agentId, slots: 1 })

      // From here on we only look for NEW sessions (workers:1 shares the agent).
      const since = new Date()
      await wsRequest(terosPage, "board.set-agent-play", { projectId, agentId, enabled: true })

      const session = await waitForUsageSessionByAgent(agentId as string, {
        triggerKind: "autorun",
        since,
        timeoutMs: 90_000,
      })
      expect(session, "autoplay opened an 'autorun' session").not.toBeNull()
      // Payload-exact: the real origin is 'autorun' (not the bug's 'user_message').
      expect(session?.triggerKind, "triggerKind = autorun").toBe("autorun")
      // Attributed to the workspace OWNER, never to 'system'.
      expect(session?.userId, "userId = workspace.ownerId (not 'system')").toBe(ownerId)
      expect(session?.userId, "userId is never 'system'").not.toBe("system")

      // Clean up the channel autoplay created (as the owner).
      if (session?.channelId) await closeChannel(terosPage, session.channelId)
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
    }
  })
})
