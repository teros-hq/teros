/**
 * Unit — handleMessageComplete usage metadata fallback (TER-446)
 *
 * The LLM callback now sends model/provider/generation info as
 * `data.responseMetadata`; the legacy shape was `data.metadata`. handleMessageComplete
 * merges them with responseMetadata winning, then feeds provider/actualModel/
 * generationId into usageTrackingService.trackUsage. A regression here mislabels
 * every usage row (wrong provider/model in billing). This asserts the merged
 * precedence and the legacy fallback against a faithful trackUsage mock.
 */

import { describe, expect, it, mock } from 'bun:test';
import { handleMessageComplete } from '../../../../packages/backend/src/handlers/message/agent-loop';
import { createStreamingState } from '../../../../packages/backend/src/handlers/message/streaming-state';

function setup() {
  const trackUsage = mock(async () => undefined);
  const ctx = {
    db: { collection: () => ({ findOne: async () => ({ workspaceId: 'w1' }) }) },
    channelManager: { getChannel: async () => ({ userId: 'u1', agentId: 'a1', workspaceId: 'w1' }) },
    usageService: { updateUsage: mock(async () => undefined) },
    usageTrackingService: { trackUsage },
    agentUsageSessionService: null, // skips the session.delta branch (needs sessionUsageId too)
    broadcastToChannel: () => undefined,
    broadcastChannelListStatus: () => undefined,
    broadcastChannelStatus: () => undefined,
    maybeAutonameChannel: async () => undefined,
  } as any;
  const agentConfig = { coreId: 'c1', llm: { modelId: 'm1', provider: 'provider-default', modelString: 'ms1' } };
  // Real state factory (faithful mock) + a saved message so the trackUsage path runs.
  const streamState = createStreamingState();
  streamState.savedMessages.push({ messageId: 'msg_last', type: 'text' });
  const streamHelpers = { completeTextMessage: async () => undefined } as any;
  const typingManager = { stop: () => undefined } as any;
  const run = (data: any) =>
    handleMessageComplete(ctx, 'ch_1', 'a1', agentConfig, data, streamState, streamHelpers, typingManager);
  return { run, trackUsage };
}

const USAGE = { inputTokens: 10, outputTokens: 5 };

describe('handleMessageComplete — responseMetadata precedence', () => {
  it('responseMetadata overrides the legacy metadata shape', async () => {
    const { run, trackUsage } = setup();
    await run({
      usage: USAGE,
      metadata: { provider: 'old-provider', model: 'old-model', id: 'old-gen' },
      responseMetadata: { provider: 'new-provider', model: 'new-model', id: 'new-gen' },
    });
    expect(trackUsage).toHaveBeenCalledTimes(1);
    const arg = trackUsage.mock.calls[0][0];
    expect(arg.provider).toBe('new-provider');
    expect(arg.actualModel).toBe('new-model');
    expect(arg.generationId).toBe('new-gen');
  });

  it('falls back to legacy data.metadata when responseMetadata is absent', async () => {
    const { run, trackUsage } = setup();
    await run({
      usage: USAGE,
      metadata: { provider: 'legacy-provider', model: 'legacy-model', id: 'legacy-gen' },
    });
    const arg = trackUsage.mock.calls[0][0];
    expect(arg.provider).toBe('legacy-provider');
    expect(arg.actualModel).toBe('legacy-model');
    expect(arg.generationId).toBe('legacy-gen');
  });

  it('falls back to agentConfig provider when neither metadata carries one', async () => {
    const { run, trackUsage } = setup();
    await run({ usage: USAGE });
    const arg = trackUsage.mock.calls[0][0];
    expect(arg.provider).toBe('provider-default');
    expect(arg.actualModel).toBeUndefined();
  });
});
