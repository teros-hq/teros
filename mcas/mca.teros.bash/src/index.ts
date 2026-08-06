#!/usr/bin/env npx tsx

/**
 * mca.teros.bash - Bash command execution MCA with Streaming support
 */

import { McaServer, spawnWithAbort } from '@teros/mca-sdk';

const DEFAULT_CWD = process.env.MCA_WORKSPACE_PATH || process.env.MCA_CWD || '/workspace';

const server = new McaServer({
  id: 'mca.teros.bash',
  name: 'Bash',
  version: '1.2.0',
});

server.tool('bash', {
  annotations: { readOnlyHint: false },
  description: 'Execute a bash command with real-time streaming output.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The bash command to execute' },
      description: { type: 'string', description: 'Description of the command' },
      cwd: { type: 'string', description: 'Working directory' },
      stream: { type: 'boolean', description: 'Enable real-time streaming (default: true)', default: true },
    },
    required: ['command', 'description'],
  },
  handler: async (args, context) => {
    const command = args.command as string;
    const cwd = (args.cwd as string) || DEFAULT_CWD;
    const isStream = args.stream !== false;
    const { channelId } = context.execution;
    const backendClient = context.backend;

    if (!command) throw new Error('command is required');

    const startTime = Date.now();
    let stdout = '';
    let stderr = '';

    const sendChunk = async (type: 'stdout' | 'stderr', data: string) => {
      if (!isStream || !backendClient || !channelId) return;
      try {
        const terminalId = channelId.startsWith('terminal:')
          ? channelId.slice('terminal:'.length)
          : channelId;
        await backendClient.emitEvent({
          event: 'terminal_output',
          payload: { type, data, terminalId },
        });
      } catch {
        // Silent fail on stream error
      }
    };

    const result = await spawnWithAbort('/bin/bash', ['-c', command], {
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1' },
      signal: context.signal,
      onStdout: (chunk) => { stdout += chunk; sendChunk('stdout', chunk); },
      onStderr: (chunk) => { stderr += chunk; sendChunk('stderr', chunk); },
    });

    const duration = Date.now() - startTime;
    if (result.kind === 'spawnError') {
      return {
        stdout,
        stderr: stderr + (result.error.message || 'Spawn error'),
        exitCode: 1,
        duration: `${duration}ms`,
        command,
        cwd,
      };
    }

    return {
      stdout: stdout || (result.exitCode === 0 ? '(no output)' : ''),
      stderr,
      exitCode: result.exitCode,
      duration: `${duration}ms`,
      command,
      cwd,
      ...(result.cancelled ? { cancelled: true, signal: result.signal } : {}),
    };
  },
});

server.start().catch((error) => {
  console.error('Failed to start MCA:', error);
  process.exit(1);
});
