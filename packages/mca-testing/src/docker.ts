import { execSync } from 'child_process';
import path from 'path';
import { McaTestClient } from './mca-client';
import { MockBackendServer } from './mock-backend';
import { MockOpenAIServer } from './mock-openai';

export interface McaTestEnvConfig {
  mcaId: string;
  profiles?: string[];
  env?: Record<string, string>;
  mcaPort?: number;
  mockBackendPort?: number;
  mockOpenAIPort?: number;
  startMockOpenAI?: boolean;
  composeFile?: string;
  repoRoot?: string;
  callbackToken?: string;
}

export interface McaTestEnvironment {
  mcaClient: McaTestClient;
  mockBackend: MockBackendServer;
  mockOpenAI?: MockOpenAIServer;
  start(): Promise<void>;
  stop(): Promise<void>;
}

const CALLBACK_HOST =
  process.platform === 'linux' ? '172.17.0.1' : 'host.docker.internal';

function findRepoRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
  } catch {
    return process.cwd();
  }
}

function ensureRuntimeImage(repoRoot: string): void {
  try {
    const out = execSync('docker images -q teros/mca-runtime:latest', { encoding: 'utf-8' }).trim();
    if (out) return;
  } catch { /* image check failed, rebuild */ }
  execSync(
    `docker build -t teros/mca-runtime:latest -f ${repoRoot}/docker/mca-runtime/Dockerfile ${repoRoot} -q`,
    { stdio: 'inherit', cwd: repoRoot },
  );
}

export function createMcaTestEnv(config: McaTestEnvConfig): McaTestEnvironment {
  const repoRoot = config.repoRoot ?? findRepoRoot();
  const mcaPort = config.mcaPort ?? 13000;
  const mockBackendPort = config.mockBackendPort ?? 9900;
  const mockOpenAIPort = config.mockOpenAIPort ?? 9901;
  const callbackToken = config.callbackToken ?? 'test-callback-token';
  const composeFile = config.composeFile ?? path.join(repoRoot, 'packages/mca-testing/docker-compose.yml');

  const mockBackend = new MockBackendServer({ port: mockBackendPort, callbackToken });
  const mockOpenAI = config.startMockOpenAI ? new MockOpenAIServer({ port: mockOpenAIPort }) : undefined;

  const mcaClient = new McaTestClient({
    baseUrl: `http://localhost:${mcaPort}`,
    callbackUrl: `http://${CALLBACK_HOST}:${mockBackendPort}`,
    callbackToken,
  });

  function compose(cmd: string): void {
    const profiles = (config.profiles ?? []).map((p) => `--profile ${p}`).join(' ');
    const envVars = [
      `REPO_ROOT=${repoRoot}`,
      `MCA_ID=${config.mcaId}`,
      `MCA_PORT=${mcaPort}`,
      `MOCK_BACKEND_PORT=${mockBackendPort}`,
      `CALLBACK_HOST=${CALLBACK_HOST}`,
    ];
    if (mockOpenAI) {
      envVars.push(`OPENAI_BASE_URL=http://${CALLBACK_HOST}:${mockOpenAIPort}/v1`);
    }
    if (config.env) {
      for (const [k, v] of Object.entries(config.env)) {
        envVars.push(`${k}=${v}`);
      }
    }
    const envPrefix = envVars.join(' ');
    const fullCmd = `${envPrefix} docker compose -p teros-mca-test -f ${composeFile} ${profiles} ${cmd}`;
    execSync(fullCmd, { stdio: 'inherit', cwd: repoRoot });
  }

  return {
    mcaClient,
    mockBackend,
    mockOpenAI,

    async start(): Promise<void> {
      ensureRuntimeImage(repoRoot);
      await mockBackend.start();
      if (mockOpenAI) await mockOpenAI.start();

      try {
        compose('up -d --wait --wait-timeout 60');
      } catch (err) {
        if (mockOpenAI) await mockOpenAI.stop();
        await mockBackend.stop();
        throw err;
      }
    },

    async stop(): Promise<void> {
      try {
        compose('down -v');
      } finally {
        if (mockOpenAI) await mockOpenAI.stop();
        await mockBackend.stop();
      }
    },
  };
}
