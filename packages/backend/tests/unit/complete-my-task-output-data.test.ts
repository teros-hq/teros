/**
 * Task outputs — complete-my-task with optional outputData.
 *
 * Verifies that when the runner agent passes `outputData` to complete-my-task:
 *   1. The handler persists it to `output.data` via `boardService.updateTask`.
 *   2. The persisted data is passed to the ActionBridge's `onTaskCompleted`.
 *   3. If no `outputData` is provided, `updateTask` is NOT called for output.data.
 *   4. If no `outputData` is provided but the task already has output.data,
 *      the existing data is still passed to the bridge.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { createCompleteMyTaskHandler } from '../../src/handlers/domains/board/complete-my-task'

const TASK_ID = 'task_out1'
const AGENT_ID = 'agent_runner'
const USER_ID = 'user_human'
const BOARD_ID = 'board_out'
const PROJECT_ID = 'proj_out'
const REVIEW_COLUMN_ID = 'col_review'
const EXEC_ID = 'exec_abc123'
const NODE_ID = 'node_action1'

function makeMockServices(taskOverrides: Record<string, any> = {}) {
  const task = {
    taskId: TASK_ID,
    assignedAgentId: AGENT_ID,
    boardId: BOARD_ID,
    columnId: 'col_doing',
    title: 'Output task',
    channelId: 'ch_sub',
    workflowExecutionId: EXEC_ID,
    workflowNodeId: NODE_ID,
    output: { schemaId: 'markdown', data: null },
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
  const project = { projectId: PROJECT_ID, workspaceId: 'work_out' }

  const boardService: any = {
    getTask: mock(async () => task),
    getBoard: mock(async () => board),
    getProject: mock(async () => project),
    moveTask: mock(async () => task),
    setRunning: mock(async () => null),
    clearStopRequest: mock(async () => null),
    updateTask: mock(async () => ({ ...task, output: { ...task.output, data: undefined } })),
  }
  const workspaceService: any = {
    getUserRole: mock(async () => 'owner'),
  }
  const pubSubService: any = {
    broadcastToTopic: mock(() => undefined),
  }
  const actionBridgeManager: any = {
    onTaskCompleted: mock(async () => ({ bridged: true, advanced: true, rejected: false })),
  }
  return { boardService, workspaceService, pubSubService, actionBridgeManager, task }
}

describe('complete-my-task with outputData', () => {
  let services: ReturnType<typeof makeMockServices>

  beforeEach(() => {
    services = makeMockServices()
  })

  it('persists outputData to output.data via updateTask before bridge fires', async () => {
    const outputData = { summary: 'Task completed', files: ['report.md'] }
    // Make updateTask return the task with the output data set
    services.boardService.updateTask = mock(async (_taskId: string, _actor: string, input: any) => ({
      ...services.task,
      output: { ...services.task.output, data: input.outputData },
    }))

    const handler = createCompleteMyTaskHandler(
      services.boardService,
      services.workspaceService,
      services.pubSubService,
      undefined,
      undefined,
      undefined,
      undefined,
      services.actionBridgeManager,
    )
    await handler({ userId: USER_ID } as any, { taskId: TASK_ID, agentId: AGENT_ID, outputData })

    // updateTask should have been called with output.data
    expect(services.boardService.updateTask).toHaveBeenCalledTimes(1)
    const updateCall = services.boardService.updateTask.mock.calls[0]
    expect(updateCall[0]).toBe(TASK_ID)
    expect(updateCall[2]).toEqual({ outputData })
  })

  it('passes the persisted output.data to the ActionBridge', async () => {
    const outputData = { result: 'success', value: 42 }
    services.boardService.updateTask = mock(async (_taskId: string, _actor: string, input: any) => ({
      ...services.task,
      output: { ...services.task.output, data: input.outputData },
    }))

    const handler = createCompleteMyTaskHandler(
      services.boardService,
      services.workspaceService,
      services.pubSubService,
      undefined,
      undefined,
      undefined,
      undefined,
      services.actionBridgeManager,
    )
    await handler({ userId: USER_ID } as any, { taskId: TASK_ID, agentId: AGENT_ID, outputData })

    expect(services.actionBridgeManager.onTaskCompleted).toHaveBeenCalledTimes(1)
    const bridgeCall = services.actionBridgeManager.onTaskCompleted.mock.calls[0]
    expect(bridgeCall[1].outputData).toEqual(outputData)
    expect(bridgeCall[1].workflowExecutionId).toBe(EXEC_ID)
    expect(bridgeCall[1].workflowNodeId).toBe(NODE_ID)
  })

  it('does NOT call updateTask when outputData is not provided', async () => {
    const handler = createCompleteMyTaskHandler(
      services.boardService,
      services.workspaceService,
      services.pubSubService,
      undefined,
      undefined,
      undefined,
      undefined,
      services.actionBridgeManager,
    )
    await handler({ userId: USER_ID } as any, { taskId: TASK_ID, agentId: AGENT_ID })

    expect(services.boardService.updateTask).not.toHaveBeenCalled()
  })

  it('still passes existing output.data to bridge when no outputData provided', async () => {
    const existingData = { preexisting: true }
    services = makeMockServices({ output: { schemaId: 'markdown', data: existingData } })

    const handler = createCompleteMyTaskHandler(
      services.boardService,
      services.workspaceService,
      services.pubSubService,
      undefined,
      undefined,
      undefined,
      undefined,
      services.actionBridgeManager,
    )
    await handler({ userId: USER_ID } as any, { taskId: TASK_ID, agentId: AGENT_ID })

    // updateTask should NOT be called (no new outputData)
    expect(services.boardService.updateTask).not.toHaveBeenCalled()
    // But the bridge should still receive the existing output.data
    expect(services.actionBridgeManager.onTaskCompleted).toHaveBeenCalledTimes(1)
    const bridgeCall = services.actionBridgeManager.onTaskCompleted.mock.calls[0]
    expect(bridgeCall[1].outputData).toEqual(existingData)
  })

  it('does NOT call updateTask when outputData is null', async () => {
    const handler = createCompleteMyTaskHandler(
      services.boardService,
      services.workspaceService,
      services.pubSubService,
      undefined,
      undefined,
      undefined,
      undefined,
      services.actionBridgeManager,
    )
    await handler({ userId: USER_ID } as any, { taskId: TASK_ID, agentId: AGENT_ID, outputData: null })

    expect(services.boardService.updateTask).not.toHaveBeenCalled()
  })

  it('completes successfully and returns the task', async () => {
    const outputData = { final: true }
    services.boardService.updateTask = mock(async (_taskId: string, _actor: string, input: any) => ({
      ...services.task,
      output: { ...services.task.output, data: input.outputData },
    }))

    const handler = createCompleteMyTaskHandler(
      services.boardService,
      services.workspaceService,
      services.pubSubService,
      undefined,
      undefined,
      undefined,
      undefined,
      services.actionBridgeManager,
    )
    const result = await handler({ userId: USER_ID } as any, { taskId: TASK_ID, agentId: AGENT_ID, outputData })

    expect(result?.task?.taskId).toBe(TASK_ID)
    expect(result?.task?.output?.data).toEqual(outputData)
  })
})
