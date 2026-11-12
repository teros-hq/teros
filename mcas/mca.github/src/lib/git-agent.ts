import { createHash } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import type { ToolContext } from '@teros/mca-sdk';

interface GitCallScope {
  agent?: string;
  context?: ToolContext;
}

const scope = new AsyncLocalStorage<GitCallScope>();

const SAFE_AGENT_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function agentDirSuffix(agentId: string): string {
  return SAFE_AGENT_RE.test(agentId) ? agentId : createHash('sha256').update(agentId).digest('hex').slice(0, 16);
}

export function agentOf(context: unknown): string | undefined {
  const agentId = (context as { execution?: { agentId?: unknown } } | undefined)?.execution?.agentId;
  return typeof agentId === 'string' && agentId.length > 0 ? agentId : undefined;
}

export function withGitCallScope<T>(context: unknown, fn: () => Promise<T>): Promise<T> {
  if (scope.getStore() !== undefined) return fn();
  const agentId = agentOf(context);
  return scope.run(
    { agent: agentId ? agentDirSuffix(agentId) : undefined, context: context as ToolContext | undefined },
    fn,
  );
}

export function currentGitAgent(): string | undefined {
  return scope.getStore()?.agent;
}

export function currentToolContext(): ToolContext | undefined {
  return scope.getStore()?.context;
}

export function agentCloneName(repo: string, agent: string): string {
  return `${repo}@${agent}`;
}
