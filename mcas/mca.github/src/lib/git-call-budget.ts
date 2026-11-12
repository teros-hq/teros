import { AsyncLocalStorage } from 'async_hooks';

export const GIT_CALL_BUDGET_MS = 115_000;

const deadline = new AsyncLocalStorage<number>();

function budgetMs(): number {
  const fromEnv = Number(process.env.MCA_GIT_CALL_BUDGET_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : GIT_CALL_BUDGET_MS;
}

export function withGitCallBudget<T>(fn: () => Promise<T>): Promise<T> {
  if (deadline.getStore() !== undefined) return fn();
  return deadline.run(Date.now() + budgetMs(), fn);
}

export function gitCallTimeLeftMs(): number | undefined {
  const at = deadline.getStore();
  return at === undefined ? undefined : at - Date.now();
}
