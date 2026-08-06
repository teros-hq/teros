// PM2 Staging Configuration for Teros — multi-instance (FASE 5d)
//
// Runs TWO backend forks against the SAME MongoDB so leader election is actually
// exercised before it ever matters in prod (prod is instances:1, so the leader
// locks have never been contended). With two owners competing:
//   - exactly one instance acquires each leader lock per tick (tracker, reset,
//     reconciliation, charge, scheduler, usage jobs),
//   - the other increments the `*_skipped_not_leader` counter on /metrics,
//   - on a graceful drain the leader RELEASES its lock (FASE 5c) so the peer
//     takes over on its next tick instead of waiting out the 60s TTL.
//
// Each fork listens on a distinct port (increment_var: 'PORT' → 10001, 10002)
// so both can bind locally; a staging load balancer can fan out across them.
// INSTANCE_ID is left to the pid-based fallback (lib/instance-id.ts), which is
// distinct per fork — that is what keeps the leader-lock ownerIds apart.
//
// Paths/env mirror ecosystem.prod.config.cjs; adjust cwd/envPath for the staging
// host. Loaded with: pm2 start ecosystem.staging.config.cjs

const fs = require('fs');

const envPath = '/opt/teros/.env';
const envVars = {};
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach((line) => {
    if (line.startsWith('#') || !line.trim()) return;
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
      let value = match[2].trim();
      if (
        (value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"'))
      ) {
        value = value.slice(1, -1);
      }
      envVars[match[1].trim()] = value;
    }
  });
}

module.exports = {
  apps: [
    {
      name: 'teros-backend-staging',
      script: 'tsx',
      args: 'src/index.ts',
      cwd: '/opt/teros/packages/backend',
      // Two forks sharing one Mongo → leader election is contended.
      instances: 2,
      exec_mode: 'fork',
      increment_var: 'PORT', // instance 0 → PORT, instance 1 → PORT+1
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production', // staging behaves like prod (JSON logs, no pretty)
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
      // Match prod: allow the billing crons to drain an in-flight tick before SIGKILL.
      kill_timeout: 30000,
      wait_ready: true,
      listen_timeout: 10000,
      error_file: '/opt/teros/logs/backend-staging-error.log',
      out_file: '/opt/teros/logs/backend-staging-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      min_uptime: '10s',
    },
    {
      // Container agent — REQUIRED: the backend has no direct Docker path
      // (CONTAINER_PROVIDER defaults to 'remote'). One agent serves both
      // staging backend forks. No wait_ready: the 'ready' IPC message does
      // not cross the tsx child process boundary.
      name: 'teros-container-agent-staging',
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
        // Core port for MCA callback URLs — staging fork 0 (PORT=10001)
        BACKEND_PORT: '10001',
        ...envVars,
      },
      error_file: '/opt/teros/logs/container-agent-staging-error.log',
      out_file: '/opt/teros/logs/container-agent-staging-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      min_uptime: '10s',
    },
  ],
};
