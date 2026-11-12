/**
 * Environment Context Service
 *
 * Builds the <environment> contribution injected into the system prompt by
 * model-service.buildSystemPrompt() behind the `prompt.environment-context`
 * feature flag. Two sources, one slot:
 *
 * FASE 1 — Harness scaffold: activates the dormant @teros/core prompt code
 * (SystemPromptBuilder/tree-generator). Produces a snapshot of the workspace
 * volume: cwd, platform, git state and a capped project file tree. The tree
 * is regenerated per request and emitted in the VOLATILE suffix so it never
 * invalidates the cached prefix.
 *
 * FASE 2 — App context prehooks: the durable architecture. The environment
 * context is contributed by the AGENT'S INSTALLED APPS, not hardcoded in the
 * core (contra Gemini CLI & copies). Each MCA declares a `contextPrehook` in
 * its manifest; the harness only owns the injection slot and the cache rules:
 *   - kind 'tool'    → volatile (recomputed per request, token-budgeted)
 *   - kind 'static'  → cacheable (stable text next to <app_instructions>)
 *
 * Design: tn_s6sH8oSb9z4ub7hV (Fase 2 idea: Pablo). Failure of any single
 * contribution degrades to its omission — never breaks the prompt.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { generateProjectTree } from '@teros/core';
import type { MCAContextPrehook } from '@teros/shared';
import type { ResolvedApp } from '../types/database';

const execAsync = promisify(exec);

/** Default token budget for a prehook tool output (heuristic 4 chars/token). */
const DEFAULT_PREHOOK_TOKEN_BUDGET = 1500;

/** Hard cap for the Fase 1 project tree (files listed). */
const PROJECT_TREE_LIMIT = 200;

/** Hard cap for the whole <environment> block, as a safety net. */
const ENVIRONMENT_BLOCK_TOKEN_CAP = 4000;

export interface EnvironmentContextInput {
  /** Host path of the workspace volume (cwd for the snapshot). */
  hostPath?: string;
  /** The agent's active apps (from McaService.getAgentApps). */
  apps: ResolvedApp[];
  /** Context for prehook tool execution. */
  execution: {
    agentId: string;
    channelId?: string;
    userId?: string;
    workspaceId?: string;
  };
  /** Execute a tool by name on the app's MCA (mcaManager.executeTool). */
  executeTool: (toolName: string, input: Record<string, any>) => Promise<{ output: string; isError: boolean }>;
}

export interface EnvironmentContextResult {
  /** Volatile contribution (changes per request) — goes in the volatile suffix. */
  volatile: string;
  /** Stable contribution (cacheable) — goes in the cached prefix. */
  stable: string;
  /** Approximate token cost of both blocks combined (4 chars/token heuristic). */
  approxTokens: number;
}

/** Truncate a string to a token budget (4 chars/token heuristic). */
function truncateToTokenBudget(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n[... truncated]';
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * FASE 1 — harness snapshot of the workspace volume.
 * Reuses @teros/core's tree-generator (the dormant scaffolding this task
 * activates) plus a lightweight git/platform probe of the volume hostPath.
 */
async function buildHarnessSnapshot(hostPath?: string): Promise<string> {
  const lines: string[] = [];

  if (hostPath) {
    lines.push(`Workspace volume: ${hostPath}`);
    try {
      const { stdout } = await execAsync(`git -C '${hostPath}' rev-parse --is-inside-work-tree 2>/dev/null && git -C '${hostPath}' branch --show-current 2>/dev/null`, { timeout: 3000 });
      const isRepo = stdout.trim().length > 0;
      lines.push(`Is directory a git repo: ${isRepo ? 'yes' : 'no'}`);
    } catch {
      lines.push('Is directory a git repo: no');
    }
  }

  lines.push(`Platform: ${process.platform} (node ${process.version})`);

  if (hostPath) {
    try {
      const tree = await generateProjectTree({ cwd: hostPath, limit: PROJECT_TREE_LIMIT });
      if (tree) {
        lines.push('');
        lines.push('<files>');
        lines.push(tree);
        lines.push('</files>');
      }
    } catch {
      // Tree generation is best-effort — omit on failure.
    }
  }

  return lines.join('\n');
}

/**
 * FASE 2 — execute one app's tool prehook and format its contribution.
 */
async function runToolPrehook(
  app: ResolvedApp,
  prehook: MCAContextPrehook,
  input: EnvironmentContextInput,
): Promise<string | null> {
  if (!prehook.tool) return null;
  try {
    const result = await input.executeTool(prehook.tool, prehook.args ?? {});
    if (result.isError || !result.output?.trim()) return null;
    const budget = prehook.maxTokens ?? DEFAULT_PREHOOK_TOKEN_BUDGET;
    return truncateToTokenBudget(result.output.trim(), budget);
  } catch {
    // Prehook failures degrade to omission — an app that cannot answer its
    // context question must not break the prompt (or the turn).
    return null;
  }
}

/**
 * Build the <environment> contributions for one request.
 * Called from model-service.buildSystemPrompt() only when the
 * `prompt.environment-context` flag is on.
 */
export async function buildEnvironmentContext(input: EnvironmentContextInput): Promise<EnvironmentContextResult> {
  const stableParts: string[] = [];
  const volatileParts: string[] = [];

  // --- FASE 2: app prehooks (the durable architecture) ---
  for (const app of input.apps) {
    const prehook = app.mca?.contextPrehook;
    if (!prehook) continue;

    const appName = app.name || app.mca?.name || 'App';

    if (prehook.text) {
      // Static contribution → cacheable prefix.
      stableParts.push(`<app_context app="${appName}" prehook="${prehook.label}">\n${prehook.text}\n</app_context>`);
      continue;
    }

    if (prehook.tool) {
      const contribution = await runToolPrehook(app, prehook, input);
      if (contribution) {
        volatileParts.push(`<app_context app="${appName}" prehook="${prehook.label}">\n${contribution}\n</app_context>`);
      }
    }
  }

  // --- FASE 1: harness snapshot (the scaffold) ---
  const snapshot = await buildHarnessSnapshot(input.hostPath);
  if (snapshot) {
    volatileParts.push(snapshot);
  }

  const volatile = volatileParts.length > 0
    ? `\n\n<environment>\n${volatileParts.join('\n\n')}\n</environment>`
    : '';
  const stable = stableParts.length > 0
    ? `\n\n${stableParts.join('\n\n')}`
    : '';

  const combined = volatile + stable;
  const approxTokens = estimateTokens(combined);

  return {
    volatile: approxTokens > ENVIRONMENT_BLOCK_TOKEN_CAP
      ? truncateToTokenBudget(volatile, ENVIRONMENT_BLOCK_TOKEN_CAP)
      : volatile,
    stable,
    approxTokens,
  };
}
