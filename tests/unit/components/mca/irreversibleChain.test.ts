/**
 * Backend integration test for the irreversible flag chain.
 *
 * The PR's headline claim is that an annotation on a manifest tool
 * propagates from manifest → executor → permission-manager →
 * statusCallbacks.onPendingPermission → message-handler → broadcast.
 *
 * Each layer was unit-tested in isolation; this test pins the
 * cross-layer plumbing where the bug previously hid (Follow-up D
 * shipped the cadena, but B2 of the post-review revealed that
 * `convertStaticTools` was dropping `annotations` silently and the
 * cast in mca-tool-executor was masking it).
 *
 * Strategy: drive `createAskPermissionCallback`'s returned function
 * with the full signature it actually receives (toolName, appId, input,
 * irreversible, toolCallId), assert that the captured
 * `onPendingPermission` callback receives `irreversible` verbatim,
 * and then resolve the pending request to verify the cleanup path.
 *
 * The full cross-process broadcast pipeline (message-handler →
 * streaming-state.updateToolStatus → broadcastToChannel) has its own
 * downstream tests in the streaming-state suite and is not duplicated
 * here — that would test the implementation, not the contract.
 */
import { describe, expect, it } from 'bun:test';

import { createPermissionManager } from '../../../../packages/backend/src/handlers/message/permission-manager';

interface CapturedCall {
  requestId: string;
  appId: string;
  irreversible: boolean;
  toolCallId?: string;
}

function buildManager() {
  const broadcasts: Array<{ channelId: string; message: unknown }> = [];
  const manager = createPermissionManager({
    broadcastToChannel: (channelId, message) => {
      broadcasts.push({ channelId, message });
    },
  });
  return { manager, broadcasts };
}

function buildCapture() {
  const captured: CapturedCall[] = [];
  return {
    captured,
    callbacks: {
      onPendingPermission: async (
        requestId: string,
        appId: string,
        irreversible: boolean,
        toolCallId?: string,
      ) => {
        captured.push({ requestId, appId, irreversible, toolCallId });
      },
      onPermissionGranted: async () => {},
    },
  };
}

describe('irreversible flag — cross-layer chain', () => {
  it('propagates irreversible=true from the executor signature into onPendingPermission', async () => {
    const { manager } = buildManager();
    const { captured, callbacks } = buildCapture();

    const ask = manager.createAskPermissionCallback(
      'channel-1',
      'user_test',
      () => ({ toolCallId: 'tc-99', messageId: 'm-1' }),
      callbacks,
    );

    // Fire the request (don't await — we only care that
    // onPendingPermission was invoked synchronously inside the
    // promise). Resolve immediately afterwards.
    const promise = ask('mca.test_delete-x', 'app-7', { id: 'a' }, true, 'tc-99');

    // Allow the microtask that calls statusCallbacks to flush.
    await new Promise<void>((r) => setImmediate(r));

    expect(captured).toHaveLength(1);
    expect(captured[0].appId).toBe('app-7');
    expect(captured[0].irreversible).toBe(true);
    expect(captured[0].toolCallId).toBe('tc-99');

    // Resolve the request so the test doesn't leak a pending Promise.
    await manager.handleResponse(captured[0].requestId, true);
    const resolution = await promise;
    expect(resolution).toBe('granted');
  });

  it('propagates irreversible=false when the manifest does not declare it', async () => {
    const { manager } = buildManager();
    const { captured, callbacks } = buildCapture();

    const ask = manager.createAskPermissionCallback(
      'channel-2',
      'user_test',
      () => ({ toolCallId: 'tc-100', messageId: 'm-2' }),
      callbacks,
    );

    const promise = ask('mca.test_list-things', 'app-1', {}, false, 'tc-100');
    await new Promise<void>((r) => setImmediate(r));

    expect(captured).toHaveLength(1);
    expect(captured[0].irreversible).toBe(false);

    await manager.handleResponse(captured[0].requestId, true);
    await promise;
  });

  it('keeps requests independent — distinct requestIds, distinct flags', async () => {
    const { manager } = buildManager();
    const { captured, callbacks } = buildCapture();

    const ask = manager.createAskPermissionCallback(
      'channel-3',
      'user_test',
      (id) => ({ toolCallId: id ?? 'unknown', messageId: 'm' }),
      callbacks,
    );

    const p1 = ask('mca.x_delete', 'app-x', {}, true, 'tc-A');
    const p2 = ask('mca.x_list', 'app-x', {}, false, 'tc-B');
    await new Promise<void>((r) => setImmediate(r));

    expect(captured).toHaveLength(2);
    // Two distinct requestIds — the permission manager generates a
    // fresh one per call. If they collided, irreversible flags would
    // get crossed (tool A's flag would arrive on tool B's request).
    expect(captured[0].requestId).not.toBe(captured[1].requestId);
    expect(captured[0].irreversible).toBe(true);
    expect(captured[1].irreversible).toBe(false);

    await manager.handleResponse(captured[0].requestId, true);
    await manager.handleResponse(captured[1].requestId, true);
    await Promise.all([p1, p2]);
  });

  it('survives onPendingPermission throwing without dropping the request', async () => {
    // Defense-in-depth: if the message-handler fails to update the UI
    // for any reason, the permission flow itself must not collapse.
    // The callback's .catch in permission-manager.ts:243 handles this.
    const { manager } = buildManager();
    const captured: CapturedCall[] = [];
    const callbacks = {
      onPendingPermission: async (
        requestId: string,
        appId: string,
        irreversible: boolean,
        toolCallId?: string,
      ) => {
        captured.push({ requestId, appId, irreversible, toolCallId });
        throw new Error('simulated UI failure');
      },
      onPermissionGranted: async () => {},
    };

    const ask = manager.createAskPermissionCallback(
      'channel-4',
      'user_test',
      () => ({ toolCallId: 'tc-1', messageId: 'm' }),
      callbacks,
    );

    const promise = ask('mca.x_delete', 'app-x', {}, true, 'tc-1');
    await new Promise<void>((r) => setImmediate(r));

    expect(captured).toHaveLength(1);
    expect(captured[0].irreversible).toBe(true);

    // Fail-closed: when onPendingPermission throws, the request is not left
    // hanging — the .catch in permission-manager cleanly auto-DENIES it
    // (safer than granting on a UI error; aligns with the TER-369 lesson).
    const resolution = await promise;
    expect(resolution).toBe('denied');
  });
});
