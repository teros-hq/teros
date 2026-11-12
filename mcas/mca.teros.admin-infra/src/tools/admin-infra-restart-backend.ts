import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';

/**
 * ⚠️  HTTP EXCEPTION: This tool uses HTTP fetch instead of WebSocket.
 *
 * Reason: POST /admin/restart causes the backend to restart. If the WS drops
 * during the process (which is likely), the WebSocket channel would be unusable
 * to send the request. HTTP is the only reliable fallback channel in this case.
 *
 * Incident 2026-11-01 08:40 (RAW) — the restart used to end halfway: pm2
 * restarted but its process came up WITHOUT the port, while an ORPHAN node
 * process (outside the pm2 tree, left over from an earlier restart) kept
 * listening on :10001 serving STALE code for ~20 minutes. The tool reported
 * "restart successful" because it only checked that the HTTP call returned.
 *
 * Incident 2026-11-02 — the e33ad2516 rewrite added a 90s verification poll
 * AFTER the POST. That poll is impossible by construction: THIS MCA is a child
 * process of the backend, so when the backend dies mid-restart the MCA dies
 * with it — the tool result never reaches the agent, the agent's turn ends
 * without a reply, and the conversation that triggered the restart hangs (the
 * resume-service only rescues channels that were running when the backend
 * died). In-call verification can never work from here. The orphan protection
 * that rewrite added lives in the BACKEND and is untouched; only the tool's
 * sequencing reverts to respond-immediately.
 *
 * This tool runs a fast, safe pre-flight and then triggers the restart:
 *   1. PRE-AUDIT  — GET /admin/port-ownership: who holds the port right now,
 *                   and do they descend from the current pm2 wrapper?
 *   2. CLEANUP    — POST /admin/kill-foreign-port: kill any NON-pm2 listener
 *                   (orphan) BEFORE restarting, so the new process can bind.
 *                   No-op when the port is already owned by the pm2 tree.
 *   3. RESTART    — POST /admin/restart (graceful SIGTERM; the backend
 *                   self-guards with a 25s shutdown watchdog < pm2's 30s
 *                   kill_timeout, so restarts stop producing orphans) — and
 *                   RETURN IMMEDIATELY on 200. No poll afterwards: the MCA
 *                   dies with the backend seconds later.
 *
 * VERIFICATION IS THE AGENT'S FIRST ACTION ON WAKE — not this tool's job:
 * when the backend comes back, system_resume revives this conversation and
 * the agent must call `admin-infra-backend-status`, which reports the real
 * listener (pid, pm2 descent, env markers) and the git commit it serves, and
 * compare it against the `expectedCommit` echoed in this response.
 */

interface PortOwnershipResponse {
  success?: boolean
  port: number
  listenerPids: number[]
  pm2WrapperPid: number | null
  listenerDescendsFromPm2: boolean | null
  listenerHasPm2Env: boolean | null
  ok: boolean
  reason: string
  checkout?: { commit: string | null; dirty: boolean | null; error?: string } | null
  timestamp?: string
  [key: string]: unknown
}

interface KillForeignResponse {
  success?: boolean
  message: string
  killed: number[]
  timestamp?: string
  [key: string]: unknown
}

export const adminInfraRestartBackend: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Restart the Teros backend server. Runs a fast pre-flight (audit who holds the backend port, kill any orphan non-pm2 listener left over from a previous restart), triggers the graceful restart, and returns IMMEDIATELY on 200 — it does NOT wait or poll, because this MCA dies with the backend seconds after the restart starts. The conversation resumes automatically when the backend is back (system_resume); FIRST ACTION on wake: call admin-infra-backend-status and verify the listener (pm2 descent) and, when expectedCommit was passed, that the served commit matches. Use with caution - this will temporarily interrupt service.',
  parameters: {
    type: 'object',
    properties: {
      confirm: {
        type: 'boolean',
        description: 'Confirmation flag - must be true to proceed with restart',
      },
      expectedCommit: {
        type: 'string',
        description:
          'Optional git commit (sha) the restarted backend is expected to serve — pass it after a git pull/checkout. It is NOT verified in-call (impossible: the MCA dies with the backend); it is echoed back so the agent can verify it via admin-infra-backend-status as its first action on wake.',
      },
    },
    required: ['confirm'],
  },
  handler: async (args, context) => {
    const confirm = args.confirm as boolean;
    const expectedCommit = typeof args.expectedCommit === 'string' ? args.expectedCommit.trim() : undefined;

    if (!confirm) {
      throw new Error(
        "Restart not confirmed. You must set 'confirm: true' to restart the backend.",
      );
    }

    // HTTP fallback — the only admin routes that remain as HTTP
    const secrets = await context.getSystemSecrets();
    const apiUrl = secrets?.ADMIN_API_URL || secrets?.admin_api_url;
    const apiKey = secrets?.ADMIN_API_KEY || secrets?.admin_api_key;

    if (!apiUrl || !apiKey) {
      throw new Error(
        'ADMIN_API_URL and ADMIN_API_KEY are required for restart (HTTP fallback). ' +
        'Configure them in system secrets.',
      );
    }

    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };

    const fetchJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
      const response = await fetch(`${apiUrl}${path}`, { ...init, headers });
      let data: Record<string, unknown> = {};
      try {
        data = (await response.json()) as Record<string, unknown>;
      } catch {
        // non-JSON body — keep {} and let the status check decide
      }
      if (!response.ok) {
        throw new Error(
          (data.message as string) || (data.error as string) || `HTTP ${response.status} on ${path}`,
        );
      }
      return data as T;
    };

    // ---------------------------------------------------------------------
    // STEP 1 — PRE-AUDIT: who holds the port right now?
    // ---------------------------------------------------------------------
    let preAudit: PortOwnershipResponse | null = null;
    try {
      preAudit = await fetchJson<PortOwnershipResponse>('/admin/port-ownership');
    } catch (error) {
      // Backend unreachable before we even start — report and abort; a
      // restart cannot fix what we cannot verify.
      throw new Error(
        `Pre-restart audit failed — backend not reachable at ${apiUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // ---------------------------------------------------------------------
    // STEP 2 — CLEANUP: kill orphan (non-pm2) listeners BEFORE restarting.
    // The pm2 tree is never touched; no-op when ownership is already clean.
    // ---------------------------------------------------------------------
    let cleanup: KillForeignResponse | null = null;
    try {
      cleanup = await fetchJson<KillForeignResponse>('/admin/kill-foreign-port', {
        method: 'POST',
      });
    } catch (error) {
      throw new Error(
        `Orphan cleanup step failed (POST /admin/kill-foreign-port): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // ---------------------------------------------------------------------
    // STEP 3 — RESTART, then return IMMEDIATELY.
    //
    // No verification poll here — it is impossible by construction: this MCA
    // is a child of the backend and dies with it seconds after this POST.
    // Verification is the agent's first action on wake (system_resume), via
    // admin-infra-backend-status (real listener + served commit).
    // ---------------------------------------------------------------------
    const restartResponse = await fetch(`${apiUrl}/admin/restart`, {
      method: 'POST',
      headers,
    });

    let restartData: Record<string, unknown> = {};
    try {
      restartData = (await restartResponse.json()) as Record<string, unknown>;
    } catch {
      // non-JSON body — fall through to the status check
    }

    if (!restartResponse.ok) {
      throw new Error(
        (restartData.message as string) ||
          (restartData.error as string) ||
          `HTTP ${restartResponse.status}`,
      );
    }

    // NOTE: spread restartData FIRST — the endpoint's own `message`
    // ("Backend restart initiated") must not clobber our wake-up instructions.
    return {
      ...restartData,
      success: true,
      message:
        'Backend restart initiated — the backend is restarting now; this conversation resumes automatically (system_resume). ' +
        'FIRST ACTION on wake: call admin-infra-backend-status and verify listener + commit' +
        (expectedCommit ? ` (expectedCommit: ${expectedCommit})` : '') +
        '.',
      expectedCommit: expectedCommit ?? null,
      preRestartAudit: preAudit
        ? { listenerPids: preAudit.listenerPids, ok: preAudit.ok, reason: preAudit.reason }
        : null,
      orphansKilled: cleanup?.killed ?? [],
      restart: restartData,
    };
  },
};
