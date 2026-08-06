/**
 * PtyManager — manages PTY sessions for the Terminal window
 *
 * Each terminal window gets a real PTY running bash inside the MCA bash
 * Docker container via `docker exec -it`. This enables full interactive
 * terminal support: vim, htop, tab completion, etc.
 */

import * as pty from 'node-pty'
import type { PubSubService } from './pubsub-service'

export interface PtySession {
  terminalId: string
  ptyProcess: pty.IPty
  containerId: string
  createdAt: Date
  /** Workspace that owns this PTY (from the app that spawned it) — used for authz */
  ownerWorkspaceId?: string
}

export class PtyManager {
  private sessions = new Map<string, PtySession>()

  constructor(private pubSubService: PubSubService) {}

  /**
   * Create a new PTY session for a terminal window.
   * Runs bash inside the MCA bash container via docker exec.
   */
  create(terminalId: string, containerId: string, cols: number, rows: number, ownerWorkspaceId?: string): void {
    if (this.sessions.has(terminalId)) {
      console.log(`[PtyManager] session ${terminalId} already exists, reusing`)
      return
    }

    console.log(`[PtyManager] creating PTY for terminal ${terminalId} in container ${containerId}`)

    // MCA containers may run on a remote execution host (TWO-HOST-SEPARATION-PLAN
    // phase 3): TERMINAL_DOCKER_HOST (e.g. ssh://user@10.99.0.2) points the
    // docker CLI there. Scoped to the terminal domain on purpose — a global
    // DOCKER_HOST would also redirect any other docker consumer in this env.
    const dockerEnv = process.env.TERMINAL_DOCKER_HOST
      ? { DOCKER_HOST: process.env.TERMINAL_DOCKER_HOST }
      : {}

    const ptyProcess = pty.spawn('docker', ['exec', '-it', containerId, '/bin/bash'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: process.env.HOME || '/',
      env: { ...process.env, ...dockerEnv, TERM: 'xterm-256color' },
    })

    ptyProcess.onData((data: string) => {
      this.pubSubService.broadcastToTopic(`terminal:${terminalId}`, {
        type: 'terminal_output',
        data,
        terminalId,
      })
    })

    ptyProcess.onExit(({ exitCode }) => {
      console.log(`[PtyManager] PTY exited for terminal ${terminalId} (code: ${exitCode})`)
      this.sessions.delete(terminalId)
      // Notify frontend that the session ended
      this.pubSubService.broadcastToTopic(`terminal:${terminalId}`, {
        type: 'terminal_exit',
        exitCode,
        terminalId,
      })
    })

    this.sessions.set(terminalId, {
      terminalId,
      ptyProcess,
      containerId,
      createdAt: new Date(),
      ownerWorkspaceId,
    })

    console.log(`[PtyManager] PTY created for terminal ${terminalId}`)
  }

  /**
   * Check if a PTY session exists for a terminal.
   */
  has(terminalId: string): boolean {
    return this.sessions.has(terminalId)
  }

  /**
   * Workspace that owns the PTY session, or undefined if no session exists
   * (or the session was created without an owner — legacy path).
   */
  ownerOf(terminalId: string): string | undefined {
    return this.sessions.get(terminalId)?.ownerWorkspaceId
  }

  /**
   * Write input (keystrokes) to the PTY.
   */
  write(terminalId: string, data: string): void {
    const session = this.sessions.get(terminalId)
    if (!session) {
      console.warn(`[PtyManager] write: no session for terminal ${terminalId}`)
      return
    }
    session.ptyProcess.write(data)
  }

  /**
   * Resize the PTY.
   */
  resize(terminalId: string, cols: number, rows: number): void {
    const session = this.sessions.get(terminalId)
    if (!session) return
    session.ptyProcess.resize(cols, rows)
  }

  /**
   * Destroy a PTY session.
   */
  destroy(terminalId: string): void {
    const session = this.sessions.get(terminalId)
    if (!session) return
    console.log(`[PtyManager] destroying PTY for terminal ${terminalId}`)
    session.ptyProcess.kill()
    this.sessions.delete(terminalId)
  }

  /**
   * Get the container ID for a given app ID by inspecting running Docker containers.
   * Returns null if not found.
   */
  static getContainerIdForApp(appId: string): string | null {
    // Container name pattern: mca-teros-bash-{last 8 chars of appId}
    const suffix = appId.replace('app_', '').slice(-8)
    const containerName = `mca-teros-bash-${suffix}`
    return containerName
  }
}
