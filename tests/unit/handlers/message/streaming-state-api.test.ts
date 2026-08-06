/**
 * Invariant — streaming-state public API is pinned (TER-446)
 *
 * streaming-state is the streaming contract surface. If its public exports or the
 * helper method set change (a new builder, a renamed method, a removed export)
 * without anyone touching the tests, the contract drifts silently — exactly the
 * drift that left the old `streaming-state.test.ts` green-but-wrong. Pinning the
 * runtime key sets forces a test update on every API change: add `frobnicate` to
 * the module or to the helpers and this goes red until the list is updated.
 */

import { describe, expect, it } from 'bun:test';
import * as StreamingStateModule from '../../../../packages/backend/src/handlers/message/streaming-state';
import {
  createStreamingHelpers,
  createStreamingState,
} from '../../../../packages/backend/src/handlers/message/streaming-state';

// Pinned public function exports (types are erased at runtime, so absent here).
const PUBLIC_EXPORTS = [
  'buildToolStatusChunk',
  'buildToolStatusContent',
  'createStreamingHelpers',
  'createStreamingState',
  'notifyObserverPermission',
  'persistToolStatus',
  // Field-level persist for the desynced-map case (writes only the status
  // transition so it can't clobber toolName/mcaId/input persisted at start).
  'persistToolStatusFields',
];

// Pinned method surface of the object createStreamingHelpers returns.
const HELPER_METHODS = [
  'appendText',
  'completeTextMessage',
  'completeToolMessage',
  'getToolCall',
  'handleTerosMessage',
  'startTextMessage',
  'startToolMessage',
  'updateToolStatus',
];

describe('streaming-state public API', () => {
  it('exports exactly the pinned set of functions', () => {
    const actual = Object.keys(StreamingStateModule)
      .filter((k) => typeof (StreamingStateModule as Record<string, unknown>)[k] === 'function')
      .sort();
    expect(actual).toEqual(PUBLIC_EXPORTS);
  });

  it('createStreamingHelpers exposes exactly the pinned method set', () => {
    const channelManager = {
      saveMessage: async () => undefined,
      updateMessageContent: async () => undefined,
      createMessageId: () => 'msg',
      getChannel: async () => null,
    } as any;
    const helpers = createStreamingHelpers(createStreamingState(), {
      channelManager,
      channelId: 'ch',
      agentId: 'a',
      broadcastToChannel: () => undefined,
    });
    expect(Object.keys(helpers).sort()).toEqual(HELPER_METHODS);
  });
});
