/**
 * BoardApi — contract / boundary tests.
 *
 * BoardApi is a typed wrapper over Transport.request. Its non-trivial logic is a
 * recurring conditional spread `...(x !== undefined ? { x } : {})` across ~7
 * methods: a broken guard either drops an optional field or sends it as
 * `undefined`. The bite uses falsy-but-defined values (position: 0,
 * description: '') — `0 !== undefined` is true but `0 ?` is false — so a
 * `!== undefined → truthy` mutation is caught with an exact toEqual on the
 * payload (0/'' are visible to toEqual; only undefined is blind to it).
 *
 * Runner: bun:test (pure logic, node-env).
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { BoardApi } from '../BoardApi'
import { CapturingTransport } from './_helpers'

describe('BoardApi — conditional payload contract', () => {
  let transport: CapturingTransport
  let api: BoardApi

  beforeEach(() => {
    transport = new CapturingTransport()
    api = new BoardApi(transport)
  })

  it('createProject omits description when absent, includes it when empty (boundary)', () => {
    api.createProject('ws_1', 'Proyecto')
    expect(transport.last()).toEqual({
      action: 'board.create-project',
      payload: { workspaceId: 'ws_1', name: 'Proyecto' },
      options: undefined,
    })
    // '' is defined → must be carried (mutating !==undefined to truthy drops it).
    api.createProject('ws_1', 'Proyecto', '')
    expect(transport.last().payload).toEqual({ workspaceId: 'ws_1', name: 'Proyecto', description: '' })
  })

  it('moveTask carries position:0 (falsy but defined)', () => {
    api.moveTask('task_1', 'col_done')
    expect(transport.last().payload).toEqual({ taskId: 'task_1', columnId: 'col_done' })
    api.moveTask('task_1', 'col_done', 0)
    expect(transport.last().payload).toEqual({ taskId: 'task_1', columnId: 'col_done', position: 0 })
  })

  it('archiveTask always sends archived, conditionally sends note/actor', () => {
    api.archiveTask('task_1', false)
    expect(transport.last().payload).toEqual({ taskId: 'task_1', archived: false })
    api.archiveTask('task_1', true, 'done', 'manager_x')
    expect(transport.last().payload).toEqual({
      taskId: 'task_1',
      archived: true,
      archiveNote: 'done',
      actor: 'manager_x',
    })
    // Empty strings are defined → carried.
    api.archiveTask('task_1', false, '', '')
    expect(transport.last().payload).toEqual({ taskId: 'task_1', archived: false, archiveNote: '', actor: '' })
  })

  it('startTask conditionally includes agentId and prompt', () => {
    api.startTask('task_1')
    expect(transport.last().payload).toEqual({ taskId: 'task_1' })
    api.startTask('task_1', 'agent_1', '')
    expect(transport.last().payload).toEqual({ taskId: 'task_1', agentId: 'agent_1', prompt: '' })
  })

  it('stopTask conditionally includes reason', () => {
    api.stopTask('task_1')
    expect(transport.last().payload).toEqual({ taskId: 'task_1' })
    api.stopTask('task_1', '')
    expect(transport.last().payload).toEqual({ taskId: 'task_1', reason: '' })
  })

  it('addProgressNote conditionally includes actor', () => {
    api.addProgressNote('task_1', 'avance')
    expect(transport.last().payload).toEqual({ taskId: 'task_1', text: 'avance' })
    api.addProgressNote('task_1', 'avance', '')
    expect(transport.last().payload).toEqual({ taskId: 'task_1', text: 'avance', actor: '' })
  })

  it('moveMyTask carries the agentId and an optional position:0', () => {
    api.moveMyTask('task_1', 'col_done', 'agent_1')
    expect(transport.last().payload).toEqual({ taskId: 'task_1', columnId: 'col_done', agentId: 'agent_1' })
    api.moveMyTask('task_1', 'col_done', 'agent_1', 0)
    expect(transport.last().payload).toEqual({
      taskId: 'task_1',
      columnId: 'col_done',
      agentId: 'agent_1',
      position: 0,
    })
  })

  it('assignTask always includes agentId, even when null (unassign)', () => {
    api.assignTask('task_1', null)
    expect(transport.last().payload).toEqual({ taskId: 'task_1', agentId: null })
    api.assignTask('task_1', 'agent_1')
    expect(transport.last().payload).toEqual({ taskId: 'task_1', agentId: 'agent_1' })
  })

  it('spreads object updates/filters/input into the payload', () => {
    api.updateProject('proj_1', { name: 'Nuevo', description: 'd' })
    expect(transport.last()).toEqual({
      action: 'board.update-project',
      payload: { projectId: 'proj_1', name: 'Nuevo', description: 'd' },
      options: undefined,
    })
    api.listTasks('proj_1')
    expect(transport.last().payload).toEqual({ projectId: 'proj_1' })
    api.listTasks('proj_1', { columnId: 'col_1', priority: 'high' })
    expect(transport.last().payload).toEqual({ projectId: 'proj_1', columnId: 'col_1', priority: 'high' })
    api.createTask('proj_1', { title: 'Tarea' })
    expect(transport.last().payload).toEqual({ projectId: 'proj_1', title: 'Tarea' })
  })

  it('simple id-only methods send exactly { id }', () => {
    api.getProject('proj_1')
    expect(transport.last()).toEqual({ action: 'board.get-project', payload: { projectId: 'proj_1' }, options: undefined })
    api.deleteTask('task_1')
    expect(transport.last()).toEqual({ action: 'board.delete-task', payload: { taskId: 'task_1' }, options: undefined })
    api.linkConversation('task_1', 'ch_1')
    expect(transport.last().payload).toEqual({ taskId: 'task_1', channelId: 'ch_1' })
  })
})
