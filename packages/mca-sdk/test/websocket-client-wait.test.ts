/**
 * Test — waitUntilConnected tolerates the cold-start / reconnect race.
 *
 * A tool call can reach a freshly-spawned MCA (HTTP health already green) before the outbound WS
 * to the backend finishes its handshake. The backend-call methods used to throw 'Not connected to
 * backend' immediately in that window; now they await waitUntilConnected, which resolves once the
 * 'connected' event fires and only rejects if no connection arrives within the timeout.
 */

import { describe, expect, it } from 'bun:test';
import { McaWebSocketClient } from '../src/websocket-client';

function makeClient(): McaWebSocketClient {
  // Constructor does not open a socket; connect() is explicit. isConnected starts false.
  return new McaWebSocketClient({ url: 'ws://backend.test/mca?appId=app_test' });
}

describe('McaWebSocketClient.waitUntilConnected', () => {
  it("rejects with 'Not connected to backend' when no connection arrives before the timeout", async () => {
    const client = makeClient();
    await expect(client.waitUntilConnected(20)).rejects.toThrow('Not connected to backend');
  });

  it("resolves when the 'connected' event fires within the window (cold-start race)", async () => {
    const client = makeClient();
    const pending = client.waitUntilConnected(1000);
    // Simulate connection_ack arriving shortly after the call started.
    client.emit('connected');
    await expect(pending).resolves.toBeUndefined();
  });
});
