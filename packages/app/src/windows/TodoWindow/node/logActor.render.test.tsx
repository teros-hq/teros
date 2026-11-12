/**
 * Log tab shows who did what (docs/specs/todo/log-actor.md, TODOLG-REQ-2):
 * a user's and an agent's avatar from the workspace member list, the Teros
 * mark for the system, and an empty slot for a legacy entry so its text
 * lines up with the others. The member list (workspace.listMembers) is stubbed.
 *
 *   cd packages/app && npx vitest run src/windows/TodoWindow/node/logActor
 */
import { waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import "../../../i18n"
import { renderWithTamagui } from "../../../test/renderWithTamagui"
import type { LogEntry } from "../model/types"
import { LogTab } from "./LogTab"

const h = vi.hoisted(() => ({
  client: {
    on: () => {},
    off: () => {},
    workspace: {
      listMembers: async () => ({
        members: [
          { type: "user", id: "user_pablo", name: "Pablo López" },
          { type: "agent", id: "agent_nira", name: "Nira", avatarUrl: "https://x/nira.png" },
        ],
      }),
    },
  },
}))

vi.mock("../../../services/terosClientSingleton", () => ({ getTerosClient: () => h.client }))

describe("To Do log actors", () => {
  it("[TODOLG-AC-2] user, agent and system entries show their avatar and name; a legacy entry keeps the text aligned", async () => {
    const now = Date.now()
    // Oldest first, as stored; the tab shows them newest first.
    const log: LogEntry[] = [
      { timestamp: now - 4000, text: "legacy line" },
      { timestamp: now - 3000, text: "Autoplay: started by Nira", actor: { kind: "system" } },
      { timestamp: now - 2000, text: "Drafted the intro", actor: { kind: "agent", id: "agent_nira" } },
      { timestamp: now - 1000, text: "review → working", actor: { kind: "user", id: "user_pablo" } },
      { timestamp: now - 500, text: "a note", actor: { kind: "user", id: "user_gone" } },
    ]
    const { container, getByLabelText } = renderWithTamagui(<LogTab log={log} workspaceId="ws_logactor" onNote={vi.fn()} />)

    // User and agent: their avatars, labelled and titled with their names (once the member list loads).
    await waitFor(() => expect(getByLabelText("Pablo López")).toBeTruthy())
    const user = getByLabelText("Pablo López")
    expect(user.getAttribute("data-testid")).toBe("log-actor-user")
    // the web `title` lands in a useEffect after the label — wait for it
    await waitFor(() => expect(user.getAttribute("title")).toBe("Pablo López"))
    expect(user.textContent).toBe("PL") // initials: no image
    const agent = getByLabelText("Nira")
    expect(agent.getAttribute("data-testid")).toBe("log-actor-agent")
    // the web `title` lands in a useEffect after the label — wait for it
    await waitFor(() => expect(agent.getAttribute("title")).toBe("Nira"))
    expect(agent.querySelector("img, [style*='nira.png']")).toBeTruthy()

    // System: the Teros mark, labelled "Teros".
    const system = getByLabelText("Teros")
    expect(system.getAttribute("data-testid")).toBe("log-actor-system")
    // the web `title` lands in a useEffect after the label — wait for it
    await waitFor(() => expect(system.getAttribute("title")).toBe("Teros"))
    expect(system.querySelector("[data-testid='teros-mark']")).toBeTruthy()
    expect(system.textContent).toBe("")

    // Unknown id: the generic person glyph.
    const users = container.querySelectorAll("[data-testid='log-actor-user']")
    expect(users).toHaveLength(2)
    expect(users[0].querySelector(".ph-user-circle")).toBeTruthy()
    expect(users[0].textContent).toBe("")

    // Legacy: no avatar, an empty slot of the same box, so the text keeps its x.
    const slots = Array.from(container.querySelectorAll("[data-testid^='log-actor-']")) as HTMLElement[]
    expect(slots.map((s) => s.getAttribute("data-testid"))).toEqual([
      "log-actor-user",
      "log-actor-user",
      "log-actor-agent",
      "log-actor-system",
      "log-actor-none",
    ])
    const none = slots[4]
    expect(none.childElementCount).toBe(0)
    expect(none.getAttribute("aria-label")).toBeNull()
    const boxOf = (el: HTMLElement) => {
      const cs = getComputedStyle(el)
      return `${cs.width}x${cs.height}`
    }
    for (const s of slots) expect(boxOf(s)).toBe("16pxx16px")
    // Every row is [timestamp, actor slot, text]: the slot is always the second child.
    for (const s of slots) {
      const row = s.parentElement!
      expect(row.children[1]).toBe(s)
      expect(row.children).toHaveLength(3)
    }
  })
})
