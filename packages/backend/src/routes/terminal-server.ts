#!/usr/bin/env node
/**
 * Teros Terminal Server — Standalone HTTP server that speaks the Even Terminal
 * /api + SSE contract on port 3456.
 *
 * This is the entry point for `teros-terminal` CLI. It connects to the Teros
 * backend's MongoDB, creates the terminal routes, and serves them on :3456
 * so the Even phone app can connect directly.
 *
 * Usage:
 *   node dist/terminal-server.js [options]
 *
 * Options:
 *   -p, --port <n>       Port (default 3456)
 *   --mongo-url <url>    MongoDB connection URL (default: mongodb://localhost:27017)
 *   --db <name>          Database name (default: teros_pre)
 *   -h, --help           Show help
 *
 * The server prints a QR code + URL that you scan with the Even app.
 * You need a G2 token (POST /g2/tokens on the main backend) to authenticate.
 */

import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { MongoClient } from 'mongodb';

// ─── CLI args ──────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, any> {
  const a: Record<string, any> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '-p':
      case '--port':
        a.port = Number(next());
        break;
      case '--mongo-url':
        a.mongoUrl = next();
        break;
      case '--db':
        a.dbName = next();
        break;
      case '-h':
      case '--help':
        a.help = true;
        break;
    }
  }
  return a;
}

function lanAddress(): string | undefined {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return undefined;
}

const HELP = `teros-terminal — run Teros agents on Even Realities G2 glasses

Usage: teros-terminal [options]

Options:
  -p, --port <n>       Port to listen on (default 3456)
  --mongo-url <url>    MongoDB connection URL (default: mongodb://localhost:27017)
  --db <name>          Database name (default: teros_pre)
  -h, --help           Show this help

You need a G2 token to authenticate. Create one on the main Teros backend:
  POST /g2/tokens  { "agentId": "agent_xxx", "label": "My G2" }
  → { "token": "g2_xxxxxxxx..." }

Then scan the QR code with the Even app. The URL includes the token.
`;

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const port = args.port ?? Number(process.env.PORT ?? 3456);
  const mongoUrl = args.mongoUrl ?? process.env.MONGO_URL ?? 'mongodb://localhost:27017';
  const dbName = args.dbName ?? process.env.DB_NAME ?? 'teros_pre';

  // Connect to MongoDB
  const client = new MongoClient(mongoUrl);
  await client.connect();
  const db = client.db(dbName);
  console.log(`[teros-terminal] Connected to MongoDB: ${mongoUrl}/${dbName}`);

  // Import route handler — we use a simplified version that doesn't need
  // the full ChannelManager/wakeUpCallback (those come from the backend).
  // For standalone mode, we delegate chat to the main backend's /g2 endpoint.
  const { createTerminalRoutes } = await import('./terminal-routes.js');

  // In standalone mode, the wakeUpCallback delegates to the main backend.
  // The main backend must be running on its normal port (3000).
  const backendUrl = process.env.BACKEND_URL ?? `http://localhost:3000`;

  // Simple wakeUpCallback that calls the backend's /g2 endpoint
  const wakeUpCallback = async (channelId: string, agentId: string, text: string) => {
    // In standalone mode, we can't directly wake up the agent.
    // The prompt() method in the provider already saves the user message
    // and calls this callback. For standalone, we POST to the backend.
    //
    // However, the terminal routes are designed to be integrated INTO the
    // backend, where the real wakeUpCallback is available. This standalone
    // server is mainly for testing the HTTP contract.
    console.log(`[teros-terminal] wakeUp: channel=${channelId} agent=${agentId} text="${text.slice(0, 60)}"`);
    console.log(`[teros-terminal] NOTE: In standalone mode, agent wake-up requires the main backend.`);
    console.log(`[teros-terminal] For full functionality, integrate terminal-routes into the backend.`);
  };

  const terminalRoutes = createTerminalRoutes({
    db,
    channelManager: null as any, // Not needed in standalone — channel creation via DB
    getWakeUpCallback: () => wakeUpCallback,
  });

  // Create HTTP server
  const server = createServer(async (req, res) => {
    const url = req.url ?? '/';
    try {
      const handled = await terminalRoutes(req, res, url);
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (err: any) {
      console.error(`[teros-terminal] Error: ${err?.message ?? err}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  await new Promise<void>((resolve) => server.listen(port, '0.0.0.0', resolve));
  const ip = lanAddress() ?? 'localhost';

  const line = '─'.repeat(54);
  console.log(`\n  teros-terminal · Teros agents on your G2 glasses`);
  console.log(`  ${line}`);
  console.log(`  Local :  http://localhost:${port}`);
  console.log(`  LAN   :  http://${ip}:${port}`);
  console.log(`  DB    :  ${mongoUrl}/${dbName}`);
  console.log(`  ${line}`);
  console.log(`\n  Connect the Even app to:`);
  console.log(`  http://${ip}:${port}?token=<your-g2-token>&defaultProvider=claude\n`);
  console.log(`  Get a token from the Teros backend:`);
  console.log(`  POST http://localhost:3000/g2/tokens { "agentId": "...", "label": "..." }\n`);

  const shutdown = async () => {
    console.log('\n[teros-terminal] Shutting down...');
    server.close();
    await client.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(`fatal: ${err?.message ?? err}`);
  process.exit(1);
});
