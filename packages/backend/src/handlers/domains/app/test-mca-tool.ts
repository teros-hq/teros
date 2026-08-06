/**
 * app.test-mca-tool — Admin-gated live tool execution keyed by catalog mcaId (Phase 7, SC1).
 *
 * Resolves a catalog `mcaId` to exactly one installed `appId` server-side (via the shared
 * `resolveMcaApp` helper — same resolution as `app.get-mca-resolvability`, D-06) and runs ONE
 * tool end-to-end by reusing the existing `mcaManager.executeTool` call path from
 * `app.execute-tool` (D-05 reuse).
 *
 * Gate order (D-05, TER-447 invariant): `requireSystemAdmin` is the FIRST executable line —
 * neither resolution nor execution runs on denial. The weaker workspace-access gate used by
 * `app.execute-tool` is deliberately NOT exposed here (D-05).
 *
 * Not-installed policy (D-01 require-pre-install): an uninstalled mcaId throws NOT_INSTALLED and
 * `mcaManager.executeTool` is never reached — no auto-provision.
 */

import type { WsHandlerContext } from "@teros/shared"
import type { Db } from "mongodb"
import { requireSystemAdmin } from "../../../auth/auth-helpers"
import { createLogger } from "../../../lib/logger"
import type { McaManager } from "../../../services/mca-manager"
import type { McaService } from "../../../services/mca-service"
import type { WorkspaceService } from "../../../services/workspace-service"
import { syntheticTestAgentId, syntheticTestChannelId } from "../../../lib/mca-test-context"
import { HandlerError } from "../../../ws-framework/WsRouter"
import { normalizeToolName } from "../../../types/permissions"
import { resolveMcaApp } from "./mca-app-resolver"

const log = createLogger("TestMcaTool")

export function createTestMcaToolHandler(
  mcaService: McaService,
  mcaManager: McaManager | null,
  db: Db,
  workspaceService: WorkspaceService | null = null,
) {
  return async function testMcaTool(ctx: WsHandlerContext, rawData: unknown) {
    // Admin-only. MUST be the first executable line — resolution/execution is
    // never invoked on denial (D-05, TER-447 invariant asserted in the unit suite).
    // The weaker workspace-access gate is deliberately NOT exposed here.
    await requireSystemAdmin(db, ctx.userId)

    const {
      mcaId,
      tool,
      input = {},
    } = rawData as {
      mcaId?: string
      tool?: string
      input?: Record<string, any>
    }
    if (!mcaId) {
      throw new HandlerError("INVALID_REQUEST", "mcaId is required")
    }
    if (!tool) {
      throw new HandlerError("MISSING_TOOL", "tool name is required")
    }
    if (!mcaManager) {
      throw new HandlerError("MCA_UNAVAILABLE", "MCA system is not available")
    }

    // D-02/D-03/D-04: resolve to exactly one installed app (own → admin's workspaces
    // → system), via the SAME helper the resolvability read uses so their answers
    // agree (D-06). The revised D-02 scope covers the admin's own workspaces because
    // installed apps are workspace-owned in practice (07-03 spike finding).
    const resolution = await resolveMcaApp(mcaService, workspaceService, ctx.userId, mcaId)
    if (!resolution.resolved) {
      // D-01: require pre-install — no auto-provision. Throw BEFORE any executor call
      // so mcaManager.executeTool is never reached on the not-installed path.
      throw new HandlerError(
        "NOT_INSTALLED",
        `No installed app for mcaId ${mcaId}; install to test`,
      )
    }

    const { app } = resolution

    // D-05 reuse: the tool name is namespaced `${app.name}_${tool}`, matching the
    // existing app.execute-tool call path. ownerId is the workspace scope.
    //
    // The mapping key is registered kebab-cased on the TOOL part only
    // (convertStaticTools: `${appName}_${normalizeToolName(originalName)}`), so a
    // snake_case tool (e.g. monday_create_board, kelify_send_message) must be
    // kebab-cased here too or executeTool misses the key and reports a false
    // "Tool mapping not found" failure. Use the SAME shared normalizer as the
    // registration path so the two can never drift. `tool` is echoed raw below.
    const fullToolName = `${app.name}_${normalizeToolName(tool)}`
    log.info(
      { mcaId, tool: fullToolName, appId: app.appId, userId: ctx.userId },
      "executing mca tool",
    )

    // This is the admin TEST path: there is no LLM agent or conversation driving the
    // call, so context fields the production path always supplies (agentId, channelId)
    // would otherwise be absent. Context-scoped MCAs hard-require them and throw:
    //   - memory: every tool calls getAgentId() → "agentId is required in execution context"
    //   - board-runner: get-my-task reads channelId → "Channel ID not available in context"
    // Apps map to agents/conversations many-to-many, so there is no single real agent or
    // channel to reuse. Synthesize deterministic, user-scoped TEST identifiers so these MCAs
    // operate against a dedicated diagnostic namespace instead of throwing — never touching a
    // real agent's memory or a real conversation's tasks. Mirror the full production context
    // shape (mca-tool-executor.ts) so new context-scoped tools don't each need a new fix.
    //
    // Isolation boundary — agent/channel ONLY. workspaceId is the resolved app's REAL
    // owner scope (app.ownerId — a workspace id, or "system" for a system app): there is
    // no synthetic workspace, so a tool that keys its state off workspaceId (workspace
    // config, shared memory, board state) reads/writes the real workspace during a test
    // run. That is inherent to "live testing against real integrations" (the run must use
    // the app's real credentials/volume), but it means destructive workspace-scoped tools
    // rely on the client-side confirm gate, not on this context, for safety.
    const result = await mcaManager.executeTool(fullToolName, input, {
      appId: app.appId,
      agentId: syntheticTestAgentId(ctx.userId),
      channelId: syntheticTestChannelId(ctx.userId),
      userId: ctx.userId,
      workspaceId: app.ownerId,
    })

    let output: any
    try {
      output = JSON.parse(result.output)
    } catch {
      output = result.output
    }

    // T-08-04-01: when the tool run failed (isError), surface the tool's returned
    // error text explicitly instead of leaving it trapped inside `result`. Derive a
    // short string message from `output` — a string is used directly; an object
    // prefers a `message`/`error`/`text` property when present, else falls back to the
    // raw `result.output` string. undefined on success. `requireSystemAdmin` above is
    // the first executable line, so only admins ever receive this text.
    let error: string | undefined
    if (result.isError) {
      if (typeof output === "string") {
        error = output
      } else if (output && typeof output === "object") {
        const obj = output as Record<string, unknown>
        const candidate = obj.message ?? obj.error ?? obj.text
        error = typeof candidate === "string" ? candidate : result.output
      } else {
        error = result.output
      }
    }

    // Typed success/error wire shape kept consistent with the resolvability read (D-06):
    // execute throws typed HandlerErrors for gate/validation/not-installed and returns
    // this success object on a real run. The full `result` payload is preserved as-is.
    return {
      mcaId,
      tool,
      appId: app.appId,
      success: !result.isError,
      result: output,
      ...(error !== undefined ? { error } : {}),
    }
  }
}
