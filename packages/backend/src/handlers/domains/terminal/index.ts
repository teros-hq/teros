/**
 * Terminal domain — PTY-based interactive terminal
 *
 * Actions:
 *   terminal.create      → Spawn a PTY inside the MCA bash container
 *   terminal.input       → Send keystrokes to the PTY
 *   terminal.resize      → Resize the PTY (cols/rows)
 *   terminal.destroy     → Kill the PTY session
 *   terminal.subscribe   → Subscribe session to terminal output events
 *   terminal.unsubscribe → Unsubscribe session from terminal output events
 *
 * Authz model (workspace is sovereign): a PTY belongs to the workspace of the
 * app that spawned it. Every action on an existing PTY verifies the caller has
 * access to that workspace — a PTY is interactive shell access to a container,
 * so an ownership gap here is remote command execution on someone else's box.
 */

import { execSync } from 'child_process'
import type { Db } from 'mongodb'
import type { WsHandlerContext } from '@teros/shared'
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsRouter } from '../../../ws-framework/WsRouter'
import type { PubSubService } from '../../../services/pubsub-service'
import type { PtyManager } from '../../../services/pty-manager'
import type { McaService } from '../../../services/mca-service'
import type { McaManager } from '../../../services/mca-manager'
import { canAccessWorkspace } from '../../../auth/workspace-access'

export interface TerminalDomainDeps {
  pubSubService: PubSubService
  ptyManager: PtyManager
  mcaService: McaService
  mcaManager: McaManager
  db: Db
  /** Shell exec override (test-only). Production default wraps execSync. */
  exec?: (cmd: string) => string
}

/**
 * Ensure the MCA bash container is running by executing a dummy command,
 * then return the actual container name via docker ps.
 */
async function ensureContainerRunning(
  mcaManager: McaManager,
  appId: string,
  userId: string,
  exec: (cmd: string) => string,
): Promise<string> {
  const toolName = 'bash_bash'
  // Execute a no-op to force the container to start
  await mcaManager.executeTool(toolName, { command: 'true', description: 'warmup' }, { appId, userId })

  // Find the container by appId suffix
  const suffix = appId.replace('app_', '').slice(-8)
  const pattern = `mca-teros-bash-${suffix}`
  try {
    const result = exec(`docker ps --filter "name=${pattern}" --format "{{.Names}}"`).trim()
    if (result) return result
  } catch { /* intentional: docker ps returned nothing — container not found, fall through to throw */ }
  throw new Error(`Container ${pattern} not found after warmup`)
}

export function register(router: WsRouter, deps: TerminalDomainDeps): void {
  const { pubSubService, ptyManager, mcaService, mcaManager, db } = deps
  // MCA containers may run on a remote execution host (TWO-HOST-SEPARATION-PLAN
  // phase 3): TERMINAL_DOCKER_HOST points the docker CLI there. Scoped env,
  // not a global DOCKER_HOST — see pty-manager.ts for the same pattern.
  const exec =
    deps.exec ??
    ((cmd: string) =>
      execSync(cmd, {
        encoding: 'utf8',
        env: process.env.TERMINAL_DOCKER_HOST
          ? { ...process.env, DOCKER_HOST: process.env.TERMINAL_DOCKER_HOST }
          : process.env,
      }))

  /**
   * Verify the caller may act on an existing PTY. Fail-closed: a session
   * without recorded owner is denied (terminal.create always records one).
   * No-ops when there is no session — callers decide how to handle absence.
   */
  async function assertTerminalAccess(ctx: WsHandlerContext, terminalId: string): Promise<void> {
    if (!ptyManager.has(terminalId)) return
    const ownerWorkspaceId = ptyManager.ownerOf(terminalId)
    if (!ownerWorkspaceId || !(await canAccessWorkspace(db, ctx.userId, ownerWorkspaceId))) {
      throw new HandlerError('FORBIDDEN_TERMINAL', `No access to terminal ${terminalId}`)
    }
  }

  /**
   * terminal.create
   * Spawns a PTY inside the MCA bash Docker container for a terminal window.
   * Ensures the container is running first by executing a warmup command.
   */
  router.register('terminal.create', async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = rawData as { terminalId: string; appId: string; cols?: number; rows?: number }

    if (!data.terminalId) throw new HandlerError('MISSING_TERMINAL_ID', 'terminalId is required')
    if (!data.appId) throw new HandlerError('MISSING_APP_ID', 'appId is required')

    // Verify user has access to the app (apps are workspace-owned:
    // ownerType 'workspace', ownerId === workspaceId)
    const app = await mcaService.getApp(data.appId)
    if (!app) throw new HandlerError('APP_NOT_FOUND', `App ${data.appId} not found`)
    const workspaceId = app.ownerId
    if (!(await canAccessWorkspace(db, ctx.userId, workspaceId))) {
      throw new HandlerError('FORBIDDEN_WORKSPACE', `No access to workspace ${workspaceId}`)
    }

    const cols = data.cols ?? 80
    const rows = data.rows ?? 24
    const topic = `terminal:${data.terminalId}`

    // If a PTY session already exists for this terminalId, just subscribe and return.
    // This handles the case of multiple browser tabs sharing the same window — they
    // all subscribe to the same topic and see the same output without spawning a new PTY.
    // The existing PTY must belong to the same workspace as the requested app:
    // otherwise a caller could attach to a foreign terminal via its terminalId.
    if (ptyManager.has(data.terminalId)) {
      if (ptyManager.ownerOf(data.terminalId) !== workspaceId) {
        throw new HandlerError('FORBIDDEN_TERMINAL', `No access to terminal ${data.terminalId}`)
      }
      pubSubService.subscribeSession(ctx.sessionId, topic)
      console.log(`✅ [terminal.create] terminal=${data.terminalId} — reusing existing PTY session`)
      return { terminalId: data.terminalId, cols, rows, reused: true }
    }

    // Ensure container is running and get its real name
    const containerId = await ensureContainerRunning(mcaManager, data.appId, ctx.userId, exec)

    // Create the PTY (recording the owning workspace for authz on later actions),
    // then subscribe — subscribing first would leave a dangling subscription if
    // the container warmup fails.
    ptyManager.create(data.terminalId, containerId, cols, rows, workspaceId)
    pubSubService.subscribeSession(ctx.sessionId, topic)

    console.log(`✅ [terminal.create] terminal=${data.terminalId} container=${containerId}`)
    return { terminalId: data.terminalId, cols, rows }
  })

  /**
   * terminal.input
   * Sends keystrokes to the PTY.
   */
  router.register('terminal.input', async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = rawData as { terminalId: string; data: string }
    if (!data.terminalId) throw new HandlerError('MISSING_TERMINAL_ID', 'terminalId is required')
    await assertTerminalAccess(ctx, data.terminalId)
    ptyManager.write(data.terminalId, data.data)
    return { ok: true }
  })

  /**
   * terminal.resize
   * Resizes the PTY.
   */
  router.register('terminal.resize', async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = rawData as { terminalId: string; cols: number; rows: number }
    if (!data.terminalId) throw new HandlerError('MISSING_TERMINAL_ID', 'terminalId is required')
    await assertTerminalAccess(ctx, data.terminalId)
    ptyManager.resize(data.terminalId, data.cols, data.rows)
    return { ok: true }
  })

  /**
   * terminal.destroy
   * Kills the PTY session.
   */
  router.register('terminal.destroy', async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = rawData as { terminalId: string }
    if (!data.terminalId) throw new HandlerError('MISSING_TERMINAL_ID', 'terminalId is required')

    await assertTerminalAccess(ctx, data.terminalId)
    ptyManager.destroy(data.terminalId)
    pubSubService.unsubscribeSession(ctx.sessionId, `terminal:${data.terminalId}`)

    console.log(`✅ [terminal.destroy] terminal=${data.terminalId}`)
    return { ok: true }
  })

  /**
   * terminal.subscribe
   * Subscribes the current session to streaming output for a terminal window.
   * Requires a live PTY: terminal output is shell I/O, so blind subscriptions
   * to arbitrary future terminalIds are not allowed.
   */
  router.register('terminal.subscribe', async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = rawData as { terminalId: string }
    if (!data.terminalId) throw new HandlerError('MISSING_TERMINAL_ID', 'terminalId is required')

    if (!ptyManager.has(data.terminalId)) {
      throw new HandlerError('TERMINAL_NOT_FOUND', `Terminal ${data.terminalId} not found`)
    }
    await assertTerminalAccess(ctx, data.terminalId)

    const topic = `terminal:${data.terminalId}`
    pubSubService.subscribeSession(ctx.sessionId, topic)

    console.log(`✅ [terminal.subscribe] session=${ctx.sessionId} subscribed to ${topic}`)
    return { terminalId: data.terminalId, topic }
  })

  /**
   * terminal.unsubscribe
   * Unsubscribes the current session from a terminal's streaming output.
   * Always allowed — it only removes the caller's own subscription.
   */
  router.register('terminal.unsubscribe', async (ctx: WsHandlerContext, rawData: unknown) => {
    const data = rawData as { terminalId: string }
    if (!data.terminalId) throw new HandlerError('MISSING_TERMINAL_ID', 'terminalId is required')

    const topic = `terminal:${data.terminalId}`
    pubSubService.unsubscribeSession(ctx.sessionId, topic)

    console.log(`✅ [terminal.unsubscribe] session=${ctx.sessionId} unsubscribed from ${topic}`)
    return { terminalId: data.terminalId }
  })
}
