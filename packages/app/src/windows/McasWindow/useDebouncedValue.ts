/**
 * useDebouncedValue — reusable debounce hook (Phase 4, STACK.md zero-new-deps).
 *
 * Standard setTimeout-in-useEffect debounce: returns `value` unchanged until it has
 * remained stable for `delayMs`. Used by the redesigned Health window search box so the
 * filter-within-groups pass runs on the settled query rather than every keystroke.
 * No lodash / debounce package — the repo has no prior reusable debounce hook.
 */

import { useEffect, useState } from "react"

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs])

  return debounced
}
