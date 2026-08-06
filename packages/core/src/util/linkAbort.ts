/**
 * One-way: aborts on `parent` propagate to `child` with the same reason;
 * aborting `child` does not affect `parent`. Portable alternative to
 * `AbortSignal.any([...])` (which requires Node 20.3+).
 */
export function linkAbort(child: AbortController, parent?: AbortSignal): void {
  if (!parent) return;
  if (parent.aborted) {
    child.abort(parent.reason);
    return;
  }
  parent.addEventListener('abort', () => child.abort(parent.reason), {
    once: true,
  });
}
