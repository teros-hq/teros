/**
 * Workspace persistence helpers for mca.teros.browser.
 *
 * Objects-first (WS1c) persists media via ctx.objects.put → backend object
 * store (/data/agent-apps-objects/<appId>/obj_*), which is permanent and
 * publicly retrievable via GET /objects/:objectId — but it is NOT the
 * workspace volume agents (and humans) browse.
 *
 * Incident fb_caf71ae2958c312a / fb_308df10c8279a762 (2026-10-31): the WS1c
 * code only activated on the first MCA respawn (the 12:57 backend restart)
 * and screenshots/videos "vanished" — they were in the object store, nothing
 * landed on /workspace, and a HEAD probe of the object URL 404'd (the public
 * route only handled GET), so the files looked destroyed.
 *
 * Rule after the incident: media tools must land the file on /workspace
 * (visible, immediate) AND persist the object (permanent URL). These helpers
 * implement the workspace half; the object half stays in the tool handlers
 * (ctx.objects.put).
 */

import { mkdir, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join } from "node:path"

/**
 * Root of the workspace volume inside the MCA container. Read per call (not
 * at import time) so tests can point it at a tmpdir via MCA_WORKSPACE_PATH.
 */
export function workspaceRoot(): string {
  return process.env.MCA_WORKSPACE_PATH || "/workspace"
}

export interface WorkspaceWriteResult {
  ok: boolean
  path: string
  error?: string
}

/**
 * Resolve a user-requested filename to an absolute path under the workspace.
 *
 * Policy (mirrors browser-snapshot):
 * - empty/undefined       → <root>/<defaultDir>/<defaultName>
 * - relative              → <root>/<name>          ("videos/x.webm" → <root>/videos/x.webm)
 * - absolute inside root  → as-is
 * - absolute outside root → re-rooted by basename under <root>/<defaultDir>
 *   (the container can only write inside the mounted volume)
 */
export function resolveWorkspacePath(
  requested: string | undefined,
  defaultDir: string,
  defaultName: string,
): string {
  const root = workspaceRoot()
  if (!requested || !requested.trim()) {
    return join(root, defaultDir, defaultName)
  }
  const name = requested.trim()
  if (isAbsolute(name)) {
    if (name.startsWith(root)) return name
    return join(root, defaultDir, basename(name))
  }
  return join(root, name)
}

/**
 * Write a buffer into the workspace volume. Best-effort by design: the
 * object store remains the source of truth, so a workspace failure must not
 * fail the tool — the result reports what happened and the caller surfaces
 * it in its output.
 */
export async function writeToWorkspace(
  data: Buffer | string,
  targetPath: string,
): Promise<WorkspaceWriteResult> {
  try {
    await mkdir(dirname(targetPath), { recursive: true })
    await writeFile(targetPath, data)
    return { ok: true, path: targetPath }
  } catch (error) {
    // no-empty-catch: the failure is surfaced to the caller (ok:false +
    // error) and from there into the tool output — a silent swallow here is
    // exactly what made fb_caf71ae2958c312a look like a success with no
    // file. We never throw: objects persistence wins over workspace copy.
    return {
      ok: false,
      path: targetPath,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
