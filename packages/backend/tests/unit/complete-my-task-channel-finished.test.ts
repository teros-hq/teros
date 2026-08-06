/**
 * TER-352 — channel_finished event emit when board-runner completes a task.
 *
 * Verifies the side-effect added to `createCompleteMyTaskHandler`:
 *   - If task has `originChannelId` AND eventHandler+channelManager are provided,
 *     emit a `channel_finished` event to the originChannelId.
 *   - If task has no originChannelId, the event is NOT emitted.
 *   - Errors during emit are swallowed (do not propagate to the caller).
 *
 * The handler itself does much more (moves task, broadcasts, autoplay, etc.).
 * Here we only assert the new behavior, mocking everything else.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { createCompleteMyTaskHandler } from '../../src/handlers/domains/board/complete-my-task'

const TASK_ID = 'task_x'
const AGENT_ID = 'agent_runner'
const USER_ID = 'user_human'
const CH_SUB = 'ch_sub'
const CH_PARENT = 'ch_parent'
const BOARD_ID = 'board_x'
const PROJECT_ID = 'proj_x'
const REVIEW_COLUMN_ID = 'col_review'

function makeMockServices(taskOverrides: Record<string, any> = {}) {
  const task = {
    taskId: TASK_ID,
    assignedAgentId: AGENT_ID,
    boardId: BOARD_ID,
    columnId: 'col_doing',
    title: 'Test task',
    channelId: CH_SUB,
    originChannelId: CH_PARENT,
    ...taskOverrides,
  }
  const board = {
    boardId: BOARD_ID,
    projectId: PROJECT_ID,
    columns: [
      { columnId: 'col_doing', slug: 'doing', name: 'Doing' },
      { columnId: REVIEW_COLUMN_ID, slug: 'review', name: 'Review' },
    ],
  }
  const project = { projectId: PROJECT_ID, workspaceId: 'work_x' }

  const boardService: any = {
    getTask: mock(async () => task),
    getBoard: mock(async () => board),
    getProject: mock(async () => project),
    moveTask: mock(async () => task),
    setRunning: mock(async () => task),
    clearStopRequest: mock(async () => task),
  }
  const workspaceService: any = {
    getUserRole: mock(async () => 'owner'),
  }
  const pubSubService: any = {
    broadcastToTopic: mock(() => undefined),
  }
  const channelManager: any = {
    getChannel: mock(async () => ({
      channelId: CH_SUB,
      originChannelId: CH_PARENT,
      metadata: { name: 'QA-Executor' },
    })),
  }
  const eventHandler: any = {
    handleScheduledEvent: mock(async () => undefined),
  }
  return { boardService, workspaceService, pubSubService, channelManager, eventHandler }
}

describe('TER-352 — complete-my-task emits channel_finished to originChannelId', () => {
  let services: ReturnType<typeof makeMockServices>

  beforeEach(() => {
    services = makeMockServices()
  })

  it('emits channel_finished event when task has originChannelId', async () => {
    const handler = createCompleteMyTaskHandler(
      services.boardService,
      services.workspaceService,
      services.pubSubService,
      undefined,
      undefined,
      services.channelManager,
      services.eventHandler,
    )
    await handler({ userId: USER_ID } as any, { taskId: TASK_ID, agentId: AGENT_ID })

    expect(services.eventHandler.handleScheduledEvent).toHaveBeenCalledTimes(1)
    const call = services.eventHandler.handleScheduledEvent.mock.calls[0][0]
    expect(call.eventType).toBe('channel_finished')
    expect(call.channelId).toBe(CH_PARENT)
    expect(call.metadata.observedChannelId).toBe(CH_SUB)
    expect(call.metadata.observedChannelName).toBe('QA-Executor')
    expect(call.metadata.taskId).toBe(TASK_ID)
    expect(call.metadata.taskTitle).toBe('Test task')
  })

  it('does NOT emit when task has no originChannelId', async () => {
    services = makeMockServices({ originChannelId: undefined })
    const handler = createCompleteMyTaskHandler(
      services.boardService,
      services.workspaceService,
      services.pubSubService,
      undefined,
      undefined,
      services.channelManager,
      services.eventHandler,
    )
    await handler({ userId: USER_ID } as any, { taskId: TASK_ID, agentId: AGENT_ID })

    expect(services.eventHandler.handleScheduledEvent).not.toHaveBeenCalled()
  })

  it('does NOT emit when eventHandler is not provided (backwards-compatible)', async () => {
    const handler = createCompleteMyTaskHandler(
      services.boardService,
      services.workspaceService,
      services.pubSubService,
      undefined,
      undefined,
      services.channelManager,
      undefined, // no eventHandler
    )
    await handler({ userId: USER_ID } as any, { taskId: TASK_ID, agentId: AGENT_ID })

    // No emit because eventHandler is undefined — does not throw, just skipped.
    expect(services.eventHandler.handleScheduledEvent).not.toHaveBeenCalled()
  })

  it('swallows emit errors without propagating to caller', async () => {
    services.eventHandler.handleScheduledEvent = mock(async () => {
      throw new Error('eventHandler exploded')
    })
    const handler = createCompleteMyTaskHandler(
      services.boardService,
      services.workspaceService,
      services.pubSubService,
      undefined,
      undefined,
      services.channelManager,
      services.eventHandler,
    )

    let err: Error | null = null
    let result: any = null
    try {
      result = await handler({ userId: USER_ID } as any, { taskId: TASK_ID, agentId: AGENT_ID })
    } catch (e) {
      err = e as Error
    }
    expect(err).toBeNull()
    expect(result?.task?.taskId).toBe(TASK_ID)
  })
})
