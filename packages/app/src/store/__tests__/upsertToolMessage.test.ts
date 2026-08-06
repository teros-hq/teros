/**
 * Tests para `upsertToolMessage` — single source of truth de tool execution
 * state en el store. Cubre los 3 paths principales (crear, merge, defensa)
 * + el flow estado completo del permission cycle.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { useChatStore } from '../chatStore'

function resetStore() {
  useChatStore.setState({ messages: {}, channelMessages: {}, channels: {} })
}

afterEach(() => resetStore())

describe('upsertToolMessage — crear nuevo message', () => {
  it('crea un message tool_execution cuando no existe', () => {
    useChatStore.getState().upsertToolMessage('msg_1', 'ch_x', {
      toolCallId: 'tc_1',
      toolName: 'filesystem_write',
      status: 'pending',
    })

    const message = useChatStore.getState().messages['msg_1']
    expect(message).toBeDefined()
    expect(message.id).toBe('msg_1')
    expect(message.channelId).toBe('ch_x')
    expect(message.sender).toBe('agent')
    expect(message.content).toMatchObject({
      type: 'tool_execution',
      toolCallId: 'tc_1',
      toolName: 'filesystem_write',
      status: 'pending',
    })
  })

  it('añade el message a channelMessages del canal', () => {
    useChatStore.getState().upsertToolMessage('msg_1', 'ch_x', {
      toolCallId: 'tc_1',
      toolName: 'filesystem_write',
    })

    expect(useChatStore.getState().channelMessages['ch_x']).toEqual(['msg_1'])
  })

  it('status default es "pending" cuando no se especifica', () => {
    useChatStore.getState().upsertToolMessage('msg_1', 'ch_x', {
      toolCallId: 'tc_1',
      toolName: 'filesystem_write',
    })

    const message = useChatStore.getState().messages['msg_1']
    expect((message.content as any).status).toBe('pending')
  })

  it('skip silencioso si message no existe Y falta toolName', () => {
    useChatStore.getState().upsertToolMessage('msg_ghost', 'ch_x', {
      toolCallId: 'tc_1',
      status: 'pending_permission',
    })

    expect(useChatStore.getState().messages['msg_ghost']).toBeUndefined()
    expect(useChatStore.getState().channelMessages['ch_x']).toBeUndefined()
  })
})

describe('upsertToolMessage — merge granular cuando el message existe', () => {
  it('mantiene campos del content previo y solo sobrescribe los del update', () => {
    useChatStore.getState().upsertToolMessage('msg_1', 'ch_x', {
      toolCallId: 'tc_1',
      toolName: 'filesystem_write',
      mcaId: 'mca.filesystem',
      input: { path: '/foo' },
      status: 'pending',
    })

    useChatStore.getState().upsertToolMessage('msg_1', 'ch_x', {
      toolCallId: 'tc_1',
      status: 'pending_permission',
      permissionRequestId: 'perm_xy',
      appId: 'app_fs',
    })

    const content = useChatStore.getState().messages['msg_1'].content as any
    expect(content.toolName).toBe('filesystem_write')
    expect(content.mcaId).toBe('mca.filesystem')
    expect(content.input).toEqual({ path: '/foo' })
    expect(content.status).toBe('pending_permission')
    expect(content.permissionRequestId).toBe('perm_xy')
    expect(content.appId).toBe('app_fs')
  })

  it('NO duplica el message en channelMessages al hacer merge', () => {
    useChatStore.getState().upsertToolMessage('msg_1', 'ch_x', {
      toolCallId: 'tc_1',
      toolName: 't',
    })
    useChatStore.getState().upsertToolMessage('msg_1', 'ch_x', {
      toolCallId: 'tc_1',
      status: 'running',
    })

    expect(useChatStore.getState().channelMessages['ch_x']).toEqual(['msg_1'])
  })

  it('permite limpiar permissionRequestId pasándolo como undefined', () => {
    useChatStore.getState().upsertToolMessage('msg_1', 'ch_x', {
      toolCallId: 'tc_1',
      toolName: 't',
      status: 'pending_permission',
      permissionRequestId: 'perm_xy',
      appId: 'app_a',
    })

    useChatStore.getState().upsertToolMessage('msg_1', 'ch_x', {
      toolCallId: 'tc_1',
      status: 'running',
      permissionRequestId: undefined,
    })

    const content = useChatStore.getState().messages['msg_1'].content as any
    expect(content.status).toBe('running')
    expect(content.permissionRequestId).toBeUndefined()
    // appId se mantiene del previo (no se pasó undefined explícito).
    expect(content.appId).toBe('app_a')
  })
})

describe('upsertToolMessage — permission flow completo (transiciones)', () => {
  it('pending → pending_permission → running → completed', () => {
    const ops = useChatStore.getState()

    // tool_call_start
    ops.upsertToolMessage('msg_1', 'ch_x', {
      toolCallId: 'tc_1',
      toolName: 'fs_write',
      mcaId: 'mca.fs',
      input: { path: '/x' },
      status: 'running',
    })
    expect((useChatStore.getState().messages['msg_1'].content as any).status).toBe('running')

    // tool_status_update: pending_permission
    ops.upsertToolMessage('msg_1', 'ch_x', {
      toolCallId: 'tc_1',
      status: 'pending_permission',
      permissionRequestId: 'perm_a',
      appId: 'app_fs',
    })
    let content = useChatStore.getState().messages['msg_1'].content as any
    expect(content.status).toBe('pending_permission')
    expect(content.permissionRequestId).toBe('perm_a')

    // tool_status_update: running (post grant)
    ops.upsertToolMessage('msg_1', 'ch_x', {
      toolCallId: 'tc_1',
      status: 'running',
      permissionRequestId: undefined,
    })
    content = useChatStore.getState().messages['msg_1'].content as any
    expect(content.status).toBe('running')
    expect(content.permissionRequestId).toBeUndefined()

    // tool_call_complete
    ops.upsertToolMessage('msg_1', 'ch_x', {
      toolCallId: 'tc_1',
      status: 'completed',
      output: 'OK',
      duration: 42,
    })
    content = useChatStore.getState().messages['msg_1'].content as any
    expect(content.status).toBe('completed')
    expect(content.output).toBe('OK')
    expect(content.duration).toBe(42)
    // Los campos previos se mantienen.
    expect(content.toolName).toBe('fs_write')
    expect(content.mcaId).toBe('mca.fs')
  })
})

describe('upsertToolMessage — tool calls paralelos (cada uno con su messageId)', () => {
  it('múltiples tools paralelos viven en messages separados', () => {
    const ops = useChatStore.getState()

    ops.upsertToolMessage('msg_1', 'ch_x', { toolCallId: 'tc_1', toolName: 'fs_write', status: 'pending' })
    ops.upsertToolMessage('msg_2', 'ch_x', { toolCallId: 'tc_2', toolName: 'fs_write', status: 'pending' })
    ops.upsertToolMessage('msg_3', 'ch_x', { toolCallId: 'tc_3', toolName: 'fs_write', status: 'pending' })

    expect(useChatStore.getState().channelMessages['ch_x']).toEqual(['msg_1', 'msg_2', 'msg_3'])

    // Actualizar tc_2 a pending_permission no afecta a tc_1 ni tc_3.
    ops.upsertToolMessage('msg_2', 'ch_x', {
      toolCallId: 'tc_2',
      status: 'pending_permission',
      permissionRequestId: 'perm_2',
      appId: 'app_fs',
    })

    expect((useChatStore.getState().messages['msg_1'].content as any).status).toBe('pending')
    expect((useChatStore.getState().messages['msg_2'].content as any).status).toBe('pending_permission')
    expect((useChatStore.getState().messages['msg_3'].content as any).status).toBe('pending')
  })
})
