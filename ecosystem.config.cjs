module.exports = {
  apps: [
    {
      name: "teros-backend",
      // tsx (node), not bun: node-pty emits no data under bun (terminal window)
      // and bun ignores the node-only NODE_OPTIONS dd-trace import.
      script: "node_modules/.bin/tsx",
      args: "src/index.ts",
      cwd: "./packages/backend",
      instances: 1,
      // fork, not cluster: PTY sessions and pubsub subscriptions live in memory
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "2G",
      // Allow billing crons to drain in-flight ticks before SIGKILL (see
      // DRAIN_TIMEOUT_MS in server-bootstrap). Default PM2 1.6s is too short.
      kill_timeout: 30000,
      env: {
        NODE_ENV: "development",
        PORT: "10001",
        NODE_OPTIONS: "--import dd-trace/initialize.mjs",
      },
      error_file: "./logs/backend-error.log",
      out_file: "./logs/backend-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
    },
    {
      // Container agent (daemon separation, TWO-HOST-SEPARATION-PLAN.md).
      // Inert unless the backend runs with CONTAINER_PROVIDER=remote; both
      // sides need CONTAINER_AGENT_TOKEN (loaded from .env by the agent).
      name: "teros-container-agent",
      script: "node_modules/.bin/tsx",
      args: "src/container-agent.ts",
      cwd: "./packages/backend",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "development",
        CONTAINER_AGENT_PORT: "10011",
        // Core port for MCA callback URLs (host.docker.internal:<port>)
        BACKEND_PORT: "10001",
      },
      // No wait_ready: the 'ready' IPC message does not cross the tsx child
      // process boundary, so pm2 would kill-loop the agent on listen_timeout.
      error_file: "./logs/container-agent-error.log",
      out_file: "./logs/container-agent-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
    },
    {
      name: "teros-frontend",
      script: "npx",
      args: "expo start --web --port 10002",
      cwd: "./packages/app",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: { NODE_ENV: "development", PORT: "10002" },
      error_file: "./logs/frontend-error.log",
      out_file: "./logs/frontend-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
    },
  ],
}
