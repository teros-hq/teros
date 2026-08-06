/**
 * Contract — TestClient emite EXACTAMENTE el envelope WsRequest (TER-453).
 *
 * Un WebSocketServer local captura los frames CRUDOS que el cliente pone en
 * el socket: si el shape deriva del protocolo real
 * (`{type:'request',requestId,action,data}`), el backend lo enrutaría a
 * UNKNOWN_MESSAGE_TYPE — la clase exacta de bug que dejó el carril e2e muerto.
 * También fija la correlación por requestId (una response ajena NO resuelve).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { isWsRequest } from '@teros/shared';
import { type AddressInfo, WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { TestClient } from '../utils/TestClient';

let wss: WebSocketServer;
let serverUrl: string;
const receivedFrames: string[] = [];
let serverSocket: WsSocket | null = null;

beforeAll(async () => {
  wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (socket) => {
    serverSocket = socket;
    socket.on('message', (data) => {
      receivedFrames.push(data.toString());
    });
  });
  await new Promise<void>((resolve) => wss.on('listening', resolve));
  serverUrl = `ws://localhost:${(wss.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

async function connectedClient(): Promise<TestClient> {
  const client = new TestClient({ url: serverUrl, timeout: 2000 });
  await client.connect();
  receivedFrames.length = 0;
  return client;
}

describe('contrato del envelope WsRequest', () => {
  test('request() emite el envelope EXACTO y pasa el type-guard del protocolo', async () => {
    const client = await connectedClient();
    try {
      const pending = client.request('channel.create', { agentId: 'agent:iria', workspaceId: 'work_x' }).catch(() => {});
      // Esperar a que el frame llegue al servidor (macrotask)
      await new Promise((r) => setTimeout(r, 50));

      expect(receivedFrames).toHaveLength(1);
      const frame = JSON.parse(receivedFrames[0]);
      expect(frame).toEqual({
        type: 'request',
        requestId: expect.stringMatching(/^req_\d+_[a-z0-9]+$/),
        action: 'channel.create',
        data: { agentId: 'agent:iria', workspaceId: 'work_x' },
      });
      // El mismo guard que usa el backend para enrutar al WsRouter
      expect(isWsRequest(frame)).toBe(true);
      await pending;
    } finally {
      await client.disconnect();
    }
  });

  test('request() sin data omite el campo (no manda data: undefined)', async () => {
    const client = await connectedClient();
    try {
      const pending = client.request('workspace.list').catch(() => {});
      await new Promise((r) => setTimeout(r, 50));

      const frame = JSON.parse(receivedFrames[0]);
      expect('data' in frame).toBe(false);
      expect(isWsRequest(frame)).toBe(true);
      await pending;
    } finally {
      await client.disconnect();
    }
  });

  test('correlación: una response con OTRO requestId no resuelve; la correcta sí', async () => {
    const client = await connectedClient();
    try {
      const promise = client.request('channel.list', {}, 3000);
      await new Promise((r) => setTimeout(r, 50));
      const sent = JSON.parse(receivedFrames[0]);

      // Response ajena primero — NO debe resolver el request
      serverSocket?.send(JSON.stringify({ type: 'response', requestId: 'req_ajeno', data: { intruso: true } }));
      // Push flat intermedio — tampoco
      serverSocket?.send(JSON.stringify({ type: 'message_sent', messageId: 'msg_1' }));
      // La correcta
      serverSocket?.send(
        JSON.stringify({ type: 'response', requestId: sent.requestId, data: { channels: [] } }),
      );

      const result = await promise;
      expect(result).toEqual({
        type: 'response',
        requestId: sent.requestId,
        data: { channels: [] },
      });
    } finally {
      await client.disconnect();
    }
  });

  test('un error del router con el requestId correlado rechaza vía requestOk', async () => {
    const client = await connectedClient();
    try {
      const promise = client.requestOk('channel.create', { agentId: 'x' }, 3000);
      await new Promise((r) => setTimeout(r, 50));
      const sent = JSON.parse(receivedFrames[0]);

      serverSocket?.send(
        JSON.stringify({
          type: 'error',
          requestId: sent.requestId,
          code: 'HANDLER_ERROR',
          message: 'workspaceId is required',
        }),
      );

      await expect(promise).rejects.toThrow('HANDLER_ERROR: workspaceId is required');
    } finally {
      await client.disconnect();
    }
  });

  test('requestIds únicos en requests consecutivos (sin colisión de correlación)', async () => {
    const client = await connectedClient();
    try {
      const p1 = client.request('a.b', {}, 1000).catch(() => {});
      const p2 = client.request('a.b', {}, 1000).catch(() => {});
      await new Promise((r) => setTimeout(r, 50));

      const ids = receivedFrames.map((f) => JSON.parse(f).requestId);
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
      await Promise.all([p1, p2]);
    } finally {
      await client.disconnect();
    }
  });

  test('el handshake auth sigue siendo flat (pre-envelope, como producción)', async () => {
    const client = await connectedClient();
    try {
      const pending = client.authenticate('a@b.com', 'pw').catch(() => {});
      await new Promise((r) => setTimeout(r, 50));

      const frame = JSON.parse(receivedFrames[0]);
      expect(frame).toEqual({
        type: 'auth',
        method: 'credentials',
        email: 'a@b.com',
        password: 'pw',
      });
      expect(isWsRequest(frame)).toBe(false);
      serverSocket?.send(JSON.stringify({ type: 'auth_success', userId: 'u', sessionToken: 't' }));
      await pending;
    } finally {
      await client.disconnect();
    }
  });
});
