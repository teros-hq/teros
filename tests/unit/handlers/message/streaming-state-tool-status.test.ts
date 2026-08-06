/**
 * Unit — tool-status layer + the TER-369 fix (TER-446)
 *
 * The `message_chunk` a tool-status update emits is the contract the frontend
 * ControlsBar/permission widget reads, so the payload is asserted byte-exact via
 * the pure builders. `updateToolStatus` carries the TER-369 fix: when the tool is
 * absent from the per-turn streamState (reload/resume isolation) it falls back to
 * `options.messageId` and STILL broadcasts (so the widget appears). It must NOT do
 * a full-content persist (a desynced map lacks toolName/input and would clobber
 * the record) — instead it writes only the status fields via
 * `persistToolStatusFields`, so the DB doesn't stay on 'pending' forever after a
 * reload (the old skip-persist behavior broke restart restore).
 */

import { describe, expect, it, mock } from 'bun:test';
import {
  buildToolStatusChunk,
  buildToolStatusContent,
  createStreamingHelpers,
  createStreamingState,
} from '../../../../packages/backend/src/handlers/message/streaming-state';

const TOOL = { toolCallId: 'tc_1', toolName: 'search', mcaId: 'mca.test', input: { q: 'x' } };
const FIXED = new Date('2026-01-01T00:00:00.000Z');

describe('buildToolStatusContent', () => {
  it('builds a plain status content with no permission fields', () => {
    const { content, permissionRequestedAt } = buildToolStatusContent(TOOL, 'running', undefined, FIXED);
    expect(content).toEqual({
      type: 'tool_execution',
      toolCallId: 'tc_1',
      toolName: 'search',
      mcaId: 'mca.test',
      input: { q: 'x' },
      status: 'running',
    });
    expect(permissionRequestedAt).toBeUndefined();
  });

  it('adds permission fields + timestamp only for pending_permission with options', () => {
    const { content, permissionRequestedAt } = buildToolStatusContent(
      TOOL,
      'pending_permission',
      { permissionRequestId: 'perm_1', appId: 'app_1', irreversible: true },
      FIXED,
    );
    expect(content.permissionRequestId).toBe('perm_1');
    expect(content.appId).toBe('app_1');
    expect(content.irreversible).toBe(true);
    expect(content.permissionRequestedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(permissionRequestedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('omits permission fields when pending_permission has no options', () => {
    const { content, permissionRequestedAt } = buildToolStatusContent(TOOL, 'pending_permission', undefined, FIXED);
    expect(content.permissionRequestId).toBeUndefined();
    expect(content.permissionRequestedAt).toBeUndefined();
    expect(permissionRequestedAt).toBeUndefined();
  });
});

describe('buildToolStatusChunk', () => {
  it('emits a bare tool_status_update chunk for non-permission statuses', () => {
    const chunk = buildToolStatusChunk({ channelId: 'ch_1', messageId: 'msg_1', toolCallId: 'tc_1', status: 'running', now: 12345 });
    expect(chunk).toEqual({
      type: 'message_chunk',
      channelId: 'ch_1',
      messageId: 'msg_1',
      chunkType: 'tool_status_update',
      toolCallId: 'tc_1',
      toolStatus: 'running',
      timestamp: 12345,
    });
  });

  it('includes permission fields only when pending_permission AND permissionRequestId present', () => {
    const chunk = buildToolStatusChunk({
      channelId: 'ch_1',
      messageId: 'msg_1',
      toolCallId: 'tc_1',
      status: 'pending_permission',
      permissionRequestId: 'perm_1',
      appId: 'app_1',
      permissionRequestedAt: '2026-01-01T00:00:00.000Z',
      irreversible: true,
      now: 12345,
    });
    expect(chunk.permissionRequestId).toBe('perm_1');
    expect(chunk.appId).toBe('app_1');
    expect(chunk.permissionRequestedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(chunk.irreversible).toBe(true);
  });

  it('omits permission fields for pending_permission WITHOUT a permissionRequestId', () => {
    const chunk = buildToolStatusChunk({ channelId: 'ch_1', messageId: 'msg_1', toolCallId: 'tc_1', status: 'pending_permission', now: 1 });
    expect(chunk).not.toHaveProperty('permissionRequestId');
    expect(chunk).not.toHaveProperty('appId');
    expect(chunk).not.toHaveProperty('irreversible');
  });
});

describe('updateToolStatus — TER-369 messageId fallback + persist guard', () => {
  function setup() {
    const state = createStreamingState();
    const updateMessageContent = mock(async () => undefined);
    const updateMessageContentFields = mock(async () => undefined);
    const broadcastToChannel = mock(() => undefined);
    const channelManager = { updateMessageContent, updateMessageContentFields, saveMessage: mock(async () => undefined), createMessageId: () => 'msg_new', getChannel: async () => null } as any;
    const helpers = createStreamingHelpers(state, { channelManager, channelId: 'ch_1', agentId: 'a_1', broadcastToChannel });
    return { state, helpers, updateMessageContent, updateMessageContentFields, broadcastToChannel };
  }

  it('does nothing without a toolCallId', async () => {
    const { helpers, updateMessageContent, broadcastToChannel } = setup();
    await helpers.updateToolStatus('running', {});
    expect(updateMessageContent).not.toHaveBeenCalled();
    expect(broadcastToChannel).not.toHaveBeenCalled();
  });

  it('persists AND broadcasts when the tool is tracked in this streamState', async () => {
    const { helpers, updateMessageContent, broadcastToChannel } = setup();
    await helpers.startToolMessage(TOOL); // tracks tc_1 in activeToolCalls
    updateMessageContent.mockClear();
    broadcastToChannel.mockClear();

    await helpers.updateToolStatus('pending_permission', { toolCallId: 'tc_1', permissionRequestId: 'perm_1', appId: 'app_1' });

    expect(updateMessageContent).toHaveBeenCalledTimes(1);
    expect(broadcastToChannel).toHaveBeenCalledTimes(1);
    const chunk = broadcastToChannel.mock.calls[0][1];
    expect(chunk.toolStatus).toBe('pending_permission');
    expect(chunk.permissionRequestId).toBe('perm_1');
  });

  it('TER-369: tool absent from streamState but options.messageId given → broadcasts, persists ONLY status fields', async () => {
    const { helpers, updateMessageContent, updateMessageContentFields, broadcastToChannel } = setup();
    // No startToolMessage → tc_1 is not in activeToolCalls (reload/resume isolation).
    await helpers.updateToolStatus('pending_permission', {
      toolCallId: 'tc_1',
      messageId: 'msg_bypass',
      permissionRequestId: 'perm_1',
      appId: 'app_1',
    });
    // Widget must still appear → broadcast happens with the bypass messageId.
    expect(broadcastToChannel).toHaveBeenCalledTimes(1);
    expect(broadcastToChannel.mock.calls[0][1].messageId).toBe('msg_bypass');
    // The full-content persist is still skipped — a desynced map lacks
    // toolName/input and a full write would clobber the record…
    expect(updateMessageContent).not.toHaveBeenCalled();
    // …but the status transition IS persisted field-level, so the DB doesn't
    // stay on 'pending' forever (permission widget must survive a reload).
    expect(updateMessageContentFields).toHaveBeenCalledTimes(1);
    const [msgId, fields] = updateMessageContentFields.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(msgId).toBe('msg_bypass');
    expect(fields.status).toBe('pending_permission');
    expect(fields.permissionRequestId).toBe('perm_1');
    expect(fields.appId).toBe('app_1');
    // Never part of a field-level write:
    expect(fields).not.toHaveProperty('toolName');
    expect(fields).not.toHaveProperty('input');
  });

  it('drops silently when the tool is untracked AND no options.messageId', async () => {
    const { helpers, updateMessageContent, broadcastToChannel } = setup();
    await helpers.updateToolStatus('running', { toolCallId: 'tc_unknown' });
    expect(updateMessageContent).not.toHaveBeenCalled();
    expect(broadcastToChannel).not.toHaveBeenCalled();
  });
});
