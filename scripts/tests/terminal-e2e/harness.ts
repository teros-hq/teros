/**
 * E2E test harness for mca.teros.terminal
 *
 * @todo nira - 2026-10-19: OBSOLETE — this harness exercised the host-PTY path,
 * which was removed with mca.teros.admin.bash on 2026-10-19 (replaced by Teros
 * Remote). It no longer runs: terminal.create has no createHost branch anymore.
 * Rewrite for container mode or delete. Kept for reference only.
 *
 * Runs the REAL backend terminal domain handlers (packages/backend/src/handlers/domains/terminal)
 * with a REAL host PTY (PtyManager.createHost — bash on this machine, no docker needed)
 * behind a WebSocket server that speaks the exact admin_request bridge protocol that
 * McaConnectionManager.handleAdminRequest implements in production.
 *
 * The MCA under test (mca.teros.terminal) connects to this harness as it would to the
 * real backend and exercises its tools end-to-end.
 *
 * Host-PTY mode was selected by the stub app's mcaId being 'mca.teros.admin.bash'
 * (retired 2026-10-19). The docker branch is covered by the backend's own unit
 * tests; the WS protocol under test is identical.
 */

import { MongoClient } from 'mongodb';
import { WebSocketServer, type WebSocket } from 'ws';
import { WsRouter } from '/opt/teros/packages/backend/src/ws-framework/WsRouter';
import { register as registerTerminalDomain } from '/opt/teros/packages/backend/src/handlers/domains/terminal';
import { PtyManager } from '/opt/teros/packages/backend/src/services/pty-manager';
import { PubSubService } from '/opt/teros/packages/backend/src/services/pubsub-service';

const PORT = 18080;
const APP_ID = 'app_cbc12f0408ef4dab';
const WORKSPACE_ID = 'ws_q14xo971fgvj3qq8y7iwjx15';

async function main() {
  const mongo = new MongoClient('mongodb://localhost:27017');
  await mongo.connect();
  const db = mongo.db('teros');

  // Real workspace + owner so canAccessWorkspace passes with real data
  const workspace = await db.collection('workspaces').findOne({ workspaceId: WORKSPACE_ID });
  if (!workspace?.ownerId) throw new Error(`Workspace ${WORKSPACE_ID} not found or has no owner`);
  const userId = workspace.ownerId as string;
  console.log(`[harness] authz user: ${userId} (owner of ${WORKSPACE_ID})`);

  const pubSubService = new PubSubService(db);
  const ptyManager = new PtyManager(pubSubService);
  const router = new WsRouter();

  // Stub app: mcaId was 'mca.teros.admin.bash' → terminal.create took the createHost
  // branch. That branch no longer exists; this harness is kept for reference only.
  const stubApp = { appId: APP_ID, mcaId: 'mca.teros.admin.bash', ownerId: WORKSPACE_ID };
  const mcaServiceStub = {
    getApp: async (appId: string) => (appId === APP_ID ? stubApp : null),
  };
  const mcaManagerStub = {
    executeTool: async () => {
      throw new Error('docker warmup not used in host-PTY mode');
    },
  };

  registerTerminalDomain(router, {
    pubSubService,
    ptyManager,
    mcaService: mcaServiceStub as any,
    mcaManager: mcaManagerStub as any,
    db,
  });

  const wss = new WebSocketServer({ port: PORT });
  wss.on('connection', (ws) => {
    console.log('[harness] MCA connected');
    ws.send(JSON.stringify({ type: 'connection_ack', serverTime: Date.now() }));

    ws.on('message', (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type !== 'admin_request') return;

      console.log(`[harness] admin_request ${msg.action}`);

      // Same fakeWs bridge as McaConnectionManager.handleAdminRequest
      const fakeWs = {
        readyState: 1,
        send(payload: string) {
          try {
            const m = JSON.parse(payload);
            if (m.type === 'response') {
              ws.send(JSON.stringify({ type: 'admin_response', requestId: msg.requestId, data: m.data }));
            } else if (m.type === 'error') {
              ws.send(JSON.stringify({ type: 'admin_response', requestId: msg.requestId, error: m.message, code: m.code }));
            }
          } catch {
            // ignore
          }
        },
      } as unknown as WebSocket;

      router
        .dispatch(fakeWs, { userId, sessionId: `mca:harness`, ip: 'harness' } as any, msg.requestId, msg.action, msg.params ?? {})
        .catch((err) => {
          console.error('[harness] dispatch error:', err.message);
          ws.send(JSON.stringify({ type: 'admin_response', requestId: msg.requestId, error: err.message, code: 'INTERNAL_ERROR' }));
        });
    });
  });

  console.log(`HARNESS_READY ws://localhost:${PORT}`);
}

main().catch((err) => {
  console.error('[harness] fatal:', err);
  process.exit(1);
});
