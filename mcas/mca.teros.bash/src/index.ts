#!/usr/bin/env npx tsx

/**
 * mca.teros.bash - Bash command execution MCA
 *
 * Migrated to use @teros/mca-sdk McaServer.
 */

import { McaServer } from '@teros/mca-sdk';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Working directory resolution:
// 1. MCA_WORKSPACE_PATH - workspace volume path (for workspace apps)
// 2. MCA_CWD - MCA's configured working directory
// 3. Fallback to teros-v2 root (../../ from mcas/mca.teros.bash/)
const DEFAULT_CWD = process.env.MCA_WORKSPACE_PATH || process.env.MCA_CWD || '../../';

// Create server
const server = new McaServer({
  id: 'mca.teros.bash',
  name: 'Bash',
  version: '1.0.0',
});

// Define bash tool
server.tool('bash', {
  description:
    'Execute a bash command with timeout and working directory support. Returns stdout, stderr, and exit code.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The bash command to execute',
      },
      description: {
        type: 'string',
        description: 'A 5-10 word description of what this command does',
      },
      timeout: {
        type: 'number',
        description:
          'Timeout in milliseconds (default: 120000 / 2 minutes, max: 600000 / 10 minutes)',
        default: 120000,
      },
      cwd: {
        type: 'string',
        description: 'Working directory to execute the command in (optional)',
      },
    },
    required: ['command', 'description'],
  },
  handler: async (args) => {
    const command = args.command as string;
    const description = args.description as string;
    const timeout = (args.timeout as number) || 120000;
    const cwd = (args.cwd as string) || DEFAULT_CWD;

    if (!command) {
      throw new Error('command is required');
    }

    if (!description) {
      throw new Error('description is required');
    }

    // Validate timeout
    const maxTimeout = 600000; // 10 minutes
    const actualTimeout = Math.min(timeout, maxTimeout);

    try {
      const startTime = Date.now();

      const { stdout, stderr } = await execAsync(command, {
        timeout: actualTimeout,
        cwd,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        shell: '/bin/bash',
      });

      const duration = Date.now() - startTime;

      return {
        stdout: stdout || '(no output)',
        stderr: stderr || '',
        exitCode: 0,
        duration: `${duration}ms`,
        command,
        cwd,
      };
    } catch (error: unknown) {
      const err = error as { stdout?: string; stderr?: string; code?: number; message?: string };

      // Return error as result (not throwing - let MCA handle formatting)
      return {
        stdout: err.stdout || '',
        stderr: err.stderr || err.message || '',
        exitCode: err.code || 1,
        error: err.message,
        command,
        cwd,
      };
    }
  },
});

// Start server
server
  .start()
  .then(() => {
    console.error('Teros Bash MCA server running');
  })
  .catch((error) => {
    console.error('Failed to start MCA:', error);
    process.exit(1);
  });
