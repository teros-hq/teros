/**
 * save-task-output — Save output data without completing the task.
 *
 * Verifies:
 *   1. Replace mode persists outputData to output.data.
 *   2. Append mode joins existing markdown with new text (double newline).
 *   3. Append mode rejects non-markdown gates with BAD_REQUEST.
 *   4. The ActionBridge is NOT called (no workflow advancement on save).
 *   5. The task is NOT moved to any column (no completion).
 *   6. Missing fields (taskId, outputData) throw MISSING_FIELDS.
 *   7. Non-existent task throws NOT_FOUND.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { createSaveTaskOutputHandler } from '../../src/handlers/domains/board/save-task-output'
import { HandlerError } from '../../src/ws-framework/WsRouter'

const TASK_ID = 'task_save1'
const USER_ID = 'user_human'
const BOARD_ID = 'board_save'
const PROJECT_ID = 'proj_save'
const EXEC_ID = 'exec_save123'

function makeMockServices(taskOverrides: Record<string, any> = {}) {
  const task = {
    taskId: TASK_ID,
    assignedAgentId: 'agent_runner',
    boardId: BOARD_ID,
    columnId: 'col_doing',
    title: 'Save output task',
    workflowExecutionId: EXEC_ID,
    workflowNodeId: 'node_action1',
    workflowOutputGate: { gateId: 'gate_out', schemaId: 'markdown' },
    output: { schemaId: 'markdown', data: null },
    ...taskOverrides,
  }
  const board = {
    boardId: BOARD_ID,
    projectId: PROJECT_ID,
    columns: [
      { columnId: 'col_doing', slug: 'doing', name: 'Doing' },
      { columnId: 'col_review', slug: 'review', name: 'Review' },
    ],
  }
  const project = { projectId: PROJECT_ID, workspaceId: 'work_save' }

  const boardService: any = {
    getTask: mock(async () => task),
    getBoard: mock(async () => board),
    getProject: mock(async () => project),
    moveTask: mock(async () => task),
    updateTask: mock(async (_taskId: string, _actor: string, input: any) => ({
      ...task,
      output: { ...task.output, data: input.outputData },
    })),
  }
  const workspaceService: any = {
    getUserRole: mock(async () => 'owner'),
  }
  const pubSubService: any = {
    broadcastToTopic: mock(() => undefined),
  }
  const boardSubscriptionService: any = {
    notifySubscribers: mock(() => undefined),
  }
  const actionBridgeManager: any = {
    onTaskCompleted: mock(async () => ({ bridged: true, advanced: true, rejected: false })),
  }
  return { boardService, workspaceService, pubSubService, boardSubscriptionService, actionBridgeManager, task }
}

describe('save-task-output', () => {
  let services: ReturnType<typeof makeMockServices>

  beforeEach(() => {
    services = makeMockServices()
  })

  it('persists outputData to output.data in replace mode', async () => {
    const outputData = 'My markdown output'
    const handler = createSaveTaskOutputHandler(
      services.boardService,
      services.workspaceService,
      services.pubSubService,
      services.boardSubscriptionService,
    )
    const result = await handler({ userId: USER_ID } as any, { taskId: TASK_ID, outputData })

    expect(services.boardService.updateTask).toHaveBeenCalledTimes(1)
    const call = services.boardService.updateTask.mock.calls[0]
    expect(call[0]).toBe(TASK_ID)
    expect(call[2]).toEqual({ outputData })
    expect(result?.task?.output?.data).toBe(outputData)
  })

  it('appends new text to existing markdown output with double newline', async () => {
    services = makeMockServices({ output: { schemaId: 'markdown', data: 'First paragraph' } })
    // updateTask returns the merged result
    services.boardService.updateTask = mock(async (_taskId: string, _actor: string, input: any) => ({
      ...services.task,
      output: { ...services.task.output, data: input.outputData },
    }))

    const handler = createSaveTaskOutputHandler(
      services.boardService,
      services.workspaceService,
      services.pubSubService,
      services.boardSubscriptionService,
    )
    const result = await handler({ userId: USER_ID } as any, {
      taskId: TASK_ID,
      outputData: 'Second paragraph',
      mode: 'append',
    })

    const call = services.boardService.updateTask.mock.calls[0]
    expect(call[2].outputData).toBe('First paragraph\n\nSecond paragraph')
    expect(result?.task?.output?.data).toBe('First paragraph\n\nSecond paragraph')
  })

  it('append mode with empty existing output just sets the new text', async () => {
    services = makeMockServices({ output: { schemaId: 'markdown', data: null } })
    services.boardService.updateTask = mock(async (_taskId: string, _actor: string, input: any) => ({
      ...services.task,
      output: { ...services.task.output, data: input.outputData },
    }))

    const handler = createSaveTaskOutputHandler(
      services.boardService,
      services.workspaceService,
      services.pubSubService,
      services.boardSubscriptionService,
    )
    await handler({ userId: USER_ID } as any, {
      taskId: TASK_ID,
      outputData: 'First content',
      mode: 'append',
    })

    const call = services.boardService.updateTask.mock.calls[0]
    expect(call[2].outputData).toBe('First content')
  })

  it('append mode rejects non-markdown gates with BAD_REQUEST', async () => {
    services = makeMockServices({
      workflowOutputGate: { gateId: 'gate_out', schemaId: 'art_structured123' },
      output: { schemaId: 'art_structured123', data: null },
    })

    const handler = createSaveTaskOutputHandler(
      services.boardService,
      services.workspaceService,
      services.pubSubService,
      services.boardSubscriptionService,
    )

    expect(
      handler({ userId: USER_ID } as any, {
        taskId: TASK_ID,
        outputData: 'some text',
        mode: 'append',
      }),
    ).rejects.toThrow(/Append mode is only supported for markdown/)

    // updateTask should NOT have been called
    expect(services.boardService.updateTask).not.toHaveBeenCalled()
  })

  it('does NOT call ActionBridge (no workflow advancement on save)', async () => {
    const handler = createSaveTaskOutputHandler(
      services.boardService,
      services.workspaceService,
      services.pubSubService,
      services.boardSubscriptionService,
    )
    await handler({ userId: USER_ID } as any, { taskId: TASK_ID, outputData: 'test' })

    // The handler doesn't even receive actionBridgeManager — verify by checking
    // that moveTask was NOT called (no column movement)
    expect(services.boardService.moveTask).not.toHaveBeenCalled()
  })

  it('does NOT move the task to any column', async () => {
    const handler = createSaveTaskOutputHandler(
      services.boardService,
      services.workspaceService,
      services.pubSubService,
      services.boardSubscriptionService,
    )
    await handler({ userId: USER_ID } as any, { taskId: TASK_ID, outputData: 'test' })

    expect(services.boardService.moveTask).not.toHaveBeenCalled()
  })

  it('broadcasts board_task_updated after save', async () => {
    const handler = createSaveTaskOutputHandler(
      services.boardService,
      services.workspaceService,
      services.pubSubService,
      services.boardSubscriptionService,
    )
    await handler({ userId: USER_ID } as any, { taskId: TASK_ID, outputData: 'test' })

    expect(services.pubSubService.broadcastToTopic).toHaveBeenCalledTimes(1)
    const broadcast = services.pubSubService.broadcastToTopic.mock.calls[0]
    expect(broadcast[0]).toBe(`board:${BOARD_ID}`)
    expect(broadcast[1].type).toBe('board_task_updated')
  })

  it('throws MISSING_FIELDS when taskId is missing', async () => {
    const handler = createSaveTaskOutputHandler(
      services.boardService,
      services.workspaceService,
      services.pubSubService,
      services.boardSubscriptionService,
    )

    expect(
      handler({ userId: USER_ID } as any, { outputData: 'test' }),
    ).rejects.toThrow(/taskId is required/)
  })

  it('throws MISSING_FIELDS when outputData is missing', async () => {
    const handler = createSaveTaskOutputHandler(
      services.boardService,
      services.workspaceService,
      services.pubSubService,
      services.boardSubscriptionService,
    )

    expect(
      handler({ userId: USER_ID } as any, { taskId: TASK_ID }),
    ).rejects.toThrow(/outputData is required/)
  })

  it('throws NOT_FOUND when task does not exist', async () => {
    services.boardService.getTask = mock(async () => null)

    const handler = createSaveTaskOutputHandler(
      services.boardService,
      services.workspaceService,
      services.pubSubService,
      services.boardSubscriptionService,
    )

    expect(
      handler({ userId: USER_ID } as any, { taskId: 'nonexistent', outputData: 'test' }),
    ).rejects.toThrow(/Task not found/)
  })

  it('supports structured output data in replace mode', async () => {
    services = makeMockServices({
      workflowOutputGate: { gateId: 'gate_out', schemaId: 'art_structured123' },
      output: { schemaId: 'art_structured123', data: null },
    })
    services.boardService.updateTask = mock(async (_taskId: string, _actor: string, input: any) => ({
      ...services.task,
      output: { ...services.task.output, data: input.outputData },
    }))

    const handler = createSaveTaskOutputHandler(
      services.boardService,
      services.workspaceService,
      services.pubSubService,
      services.boardSubscriptionService,
    )
    const outputData = { summary: 'Done', count: 42 }
    const result = await handler({ userId: USER_ID } as any, { taskId: TASK_ID, outputData })

    const call = services.boardService.updateTask.mock.calls[0]
    expect(call[2].outputData).toEqual(outputData)
    expect(result?.task?.output?.data).toEqual(outputData)
  })
})
