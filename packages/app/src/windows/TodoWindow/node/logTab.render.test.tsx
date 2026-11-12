/**
 * Log tab renders markdown (docs/specs/todo/markdown.md, TODOMD-REQ-4).
 *
 *   cd packages/app && npx vitest run src/windows/TodoWindow/node/logTab
 */
import { describe, expect, it, vi } from "vitest"
import { renderWithTamagui } from "../../../test/renderWithTamagui"
import { LogTab } from "./LogTab"

describe("To Do log tab", () => {
  it("[TODOMD-AC-4] entries render inline marks and bullets; the transition line stays plain", () => {
    const now = Date.now()
    const log = [
      { timestamp: now - 3000, text: "pending → working" },
      { timestamp: now - 2000, text: "Done: **invoice** sent, see `holded-123`" },
      { timestamp: now - 1000, text: "- first step\n- second step" },
    ]
    const { container } = renderWithTamagui(<LogTab log={log} onNote={vi.fn()} />)
    const text = container.textContent ?? ""
    expect(text).toContain("invoice")
    expect(text).toContain("holded-123")
    expect(text).not.toContain("**")
    expect(text).not.toContain("`")
    expect(text).toContain("first step")
    expect(text).toContain("second step")
    expect(text).not.toContain("- first")
    // MD-UNIFY: the unified renderer emits real <ul><li> (bullet via CSS marker),
    // so assert on the list structure rather than the old parser's literal "•".
    expect(container.querySelectorAll("li")).toHaveLength(2)
    expect(text).toContain("→")
  })
})
