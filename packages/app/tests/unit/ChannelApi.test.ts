/**
 * Unit tests for ChannelApi
 *
 * Tests the transport-level request building for channel.send-message,
 * verifying that skillIds are correctly forwarded in the payload.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { ChannelApi, type MessageContent } from '../../src/services/ChannelApi';

// Minimal mock Transport that captures request calls
function createMockTransport() {
  const requests: Array<{ method: string; data: Record<string, unknown> }> = [];

  return {
    requests,
    request: async (method: string, data: Record<string, unknown>): Promise<any> => {
      requests.push({ method, data });
      return {};
    },
  };
}

describe('ChannelApi.sendMessage', () => {
  let mockTransport: ReturnType<typeof createMockTransport>;
  let api: ChannelApi;

  beforeEach(() => {
    mockTransport = createMockTransport();
    api = new ChannelApi(mockTransport as any);
  });

  it('sends a basic text message without skillIds', async () => {
    const content: MessageContent = { type: 'text', text: 'Hello world' };
    await api.sendMessage('ch_123', content);

    expect(mockTransport.requests.length).toBe(1);
    const req = mockTransport.requests[0];
    expect(req.method).toBe('channel.send-message');
    expect(req.data.channelId).toBe('ch_123');
    expect((req.data.content as any).type).toBe('text');
    expect((req.data.content as any).text).toBe('Hello world');
    expect(req.data.skillIds).toBeUndefined();
    expect(req.data.wakeUpAgent).toBeUndefined();
  });

  it('forwards skillIds in the payload when provided', async () => {
    const content: MessageContent = { type: 'text', text: 'Use @skill-name' };
    const skillIds = ['sk_abc123', 'sk_def456'];
    await api.sendMessage('ch_123', content, { skillIds });

    expect(mockTransport.requests.length).toBe(1);
    const req = mockTransport.requests[0];
    expect(req.method).toBe('channel.send-message');
    expect(req.data.channelId).toBe('ch_123');
    expect(req.data.skillIds).toEqual(skillIds);
  });

  it('forwards both wakeUpAgent and skillIds together', async () => {
    const content: MessageContent = { type: 'text', text: 'Hello' };
    await api.sendMessage('ch_456', content, { wakeUpAgent: false, skillIds: ['sk_single'] });

    expect(mockTransport.requests.length).toBe(1);
    const req = mockTransport.requests[0];
    expect(req.data.channelId).toBe('ch_456');
    expect(req.data.wakeUpAgent).toBe(false);
    expect(req.data.skillIds).toEqual(['sk_single']);
  });

  it('does not include skillIds key when options is undefined', async () => {
    const content: MessageContent = { type: 'text', text: 'No options' };
    await api.sendMessage('ch_789', content);

    const req = mockTransport.requests[0];
    expect(req.data).not.toHaveProperty('skillIds');
  });

  it('does not include skillIds key when skillIds is not provided in options', async () => {
    const content: MessageContent = { type: 'text', text: 'Only wakeUpAgent' };
    await api.sendMessage('ch_789', content, { wakeUpAgent: true });

    const req = mockTransport.requests[0];
    expect(req.data.wakeUpAgent).toBe(true);
    expect(req.data).not.toHaveProperty('skillIds');
  });

  it('handles an empty skillIds array', async () => {
    const content: MessageContent = { type: 'text', text: 'Empty array' };
    await api.sendMessage('ch_000', content, { skillIds: [] });

    const req = mockTransport.requests[0];
    // Empty array should still be forwarded (backend schema accepts optional array)
    expect(req.data.skillIds).toEqual([]);
  });
});

describe('ChannelApi.createWithMessage', () => {
  let mockTransport: ReturnType<typeof createMockTransport>;
  let api: ChannelApi;

  beforeEach(() => {
    mockTransport = createMockTransport();
    api = new ChannelApi(mockTransport as any);
  });

  it('accepts skillIds in the type signature (forwarded to transport even if backend may not support)', async () => {
    const content: MessageContent = { type: 'text', text: 'First message' };
    await api.createWithMessage({
      agentId: 'ag_test',
      content,
      skillIds: ['sk_newchat'],
    });

    expect(mockTransport.requests.length).toBe(1);
    const req = mockTransport.requests[0];
    expect(req.method).toBe('channel.create-with-message');
    expect(req.data.agentId).toBe('ag_test');
    expect(req.data.skillIds).toEqual(['sk_newchat']);
  });
});
