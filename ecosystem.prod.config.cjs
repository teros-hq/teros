// PM2 Production Configuration for Teros
// Used in LXC 100 (prod) - os.teros.ai / be.teros.ai
//
// Uses tsx to run TypeScript directly (avoids ESM module resolution issues)
// Environment variables are loaded from /opt/teros/.env

const path = require('path');
const fs = require('fs');

// Load .env from project root
const envPath = '/opt/teros/.env';
const envVars = {};
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach((line) => {
    // Skip comments and empty lines
    if (line.startsWith('#') || !line.trim()) return;
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
      let value = match[2].trim();
      // Remove surrounding quotes (single or double)
      if ((value.startsWith("'") && value.endsWith("'")) || 
          (value.startsWith('"') && value.endsWith('"'))) {
        value = value.slice(1, -1);
      }
      envVars[match[1].trim()] = value;
    }
  });
}

module.exports = {
  apps: [
    {
      name: 'teros-backend',
      script: 'tsx',
      args: 'src/index.ts',
      cwd: '/opt/teros/packages/backend',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: '10001',
        ...envVars,
        // Datadog LLM/Agent Observability loader — must be present at spawn so
        // the tracer is initialized AND ESM imports (Anthropic/OpenAI SDKs) are
        // instrumented. initialize.mjs does both (register.js only installs the
        // ESM hooks without initializing the tracer). Merged with any
        // NODE_OPTIONS already set in /opt/teros/.env. DD_* config comes from .env.
        NODE_OPTIONS: [envVars.NODE_OPTIONS, '--import dd-trace/initialize.mjs']
          .filter(Boolean)
          .join(' '),
      },
      // Graceful shutdown — allow the billing crons to drain an in-flight tick
      // (DRAIN_TIMEOUT_MS=8s in server-bootstrap) + flush the usage buffer before
      // SIGKILL. Must exceed the drain budget.
      kill_timeout: 30000,
      wait_ready: true,
      listen_timeout: 10000,
      // Logs
      error_file: '/opt/teros/logs/backend-error.log',
      out_file: '/opt/teros/logs/backend-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      // Restart policy
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      min_uptime: '10s',
    },
    {
      // Container agent — REQUIRED: the backend has no direct Docker path
      // (CONTAINER_PROVIDER defaults to 'remote'). Owns all docker run/rm/
      // inspect for MCA containers. TWO-HOST-SEPARATION-PLAN.md.
      // No wait_ready: the 'ready' IPC message does not cross the tsx child
      // process boundary (pm2 would kill-loop the agent on listen_timeout).
      name: 'teros-container-agent',
      script: 'tsx',
      args: 'src/container-agent.ts',
      cwd: '/opt/teros/packages/backend',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        CONTAINER_AGENT_PORT: '10011',
        // Core port for MCA callback URLs (host.docker.internal:<port>)
        BACKEND_PORT: '10001',
        ...envVars,
      },
      error_file: '/opt/teros/logs/container-agent-error.log',
      out_file: '/opt/teros/logs/container-agent-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      min_uptime: '10s',
    },
  ],
};
