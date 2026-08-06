// Support module for running Cucumber against a real backend (no mock server).

export function getWsUrl(): string {
  return process.env.E2E_WS_URL || 'ws://localhost:3002/ws';
}

export function getHttpUrl(): string {
  return process.env.E2E_HTTP_URL || 'http://localhost:3002';
}
