/**
 * The terminal header shows ONE action that depends on who drives, and the
 * give-back popover sends the note to the agent:
 *   agent → Take the wheel · me → Give back (note) · someone else → Ask ·
 *   needs you → Take (amber) · two at once → Let them / Ask for it · nobody → nothing.
 *
 *   cd packages/app && npx vitest run src/windows/TerminalWindow/crew/TerminalHeader.render.test.tsx
 */
import { fireEvent, render } from "@testing-library/react"
import { TamaguiProvider } from "tamagui"
import { describe, expect, it, vi } from "vitest"
import config from "../../../../tamagui.config"
import { crewTokens, useK } from "./tokens"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) }
})

import type { TerminalSession } from "../terminalSessions"
import { describeSeat } from "./crewModel"
import { TerminalHeader } from "./TerminalHeader"

const NOW = 1_800_000_000_000
const ME = "user_me"

const session = (extra: Partial<TerminalSession>): TerminalSession => ({
  terminalId: "t1",
  title: "Tests",
  kind: "shell",
  command: "bash",
  pinned: true,
  persistent: true,
  createdBy: "agent:a1",
  createdAt: new Date(NOW - 60_000).toISOString(),
  lastActivity: new Date(NOW).toISOString(),
  cols: 80,
  rows: 24,
  agentState: null,
  viewers: 1,
  watchers: [],
  ...extra,
})

function renderHeader(s: TerminalSession) {
  const handlers = {
    onTake: vi.fn(),
    onGiveBack: vi.fn(),
    onYield: vi.fn(),
    onPopOut: vi.fn(),
    onMenu: vi.fn(),
  }
  // The header reads the app theme (crew tokens per light/dark): a provider, as the app has.
  const utils = render(
    <TamaguiProvider config={config} defaultTheme="dark">
      <TerminalHeader
        session={s}
        view={describeSeat(s, ME, NOW)}
        narrow={false}
        now={NOW}
        me={ME}
        copilot={{ id: "agent:a1", kind: "agent", name: "Atlas" }}
        menuOpen={false}
        {...handlers}
      />
    </TamaguiProvider>,
  )
  return { ...utils, ...handlers }
}

const atlas = { kind: "agent" as const, id: "agent:a1", name: "Atlas", since: NOW - 10_000 }

describe("TerminalHeader", () => {
  it("agent drives: Take the wheel", () => {
    const h = renderHeader(session({ driver: atlas }))
    expect(h.queryByTestId("crew-header-agent")).not.toBeNull()
    fireEvent.click(h.getByTestId("crew-take"))
    expect(h.onTake).toHaveBeenCalledOnce()
    expect(h.queryByTestId("crew-giveback")).toBeNull()
  })

  it("needs you: amber header, Take the wheel", () => {
    const h = renderHeader(session({ driver: atlas, agentState: { state: "blocked", at: "" } }))
    expect(h.queryByTestId("crew-header-need")).not.toBeNull()
    expect(h.queryByTestId("crew-take")).not.toBeNull()
  })

  it("I drive: Give back opens the note, Enter sends it", () => {
    const h = renderHeader(
      session({ driver: { kind: "human", id: ME, name: "Iria", since: NOW - 5000 } }),
    )
    expect(h.queryByTestId("crew-take")).toBeNull()
    fireEvent.click(h.getByTestId("crew-giveback"))
    const note = h.getByTestId("crew-giveback-note")
    fireEvent.change(note, { target: { value: "la caché, sigue tú" } })
    fireEvent.keyDown(note, { key: "Enter" })
    expect(h.onGiveBack).toHaveBeenCalledWith("la caché, sigue tú")
  })

  it("I drive: No note gives back with null", () => {
    const h = renderHeader(
      session({ driver: { kind: "human", id: ME, name: "Iria", since: NOW - 5000 } }),
    )
    fireEvent.click(h.getByTestId("crew-giveback"))
    fireEvent.click(h.getByTestId("crew-giveback-nonote"))
    expect(h.onGiveBack).toHaveBeenCalledWith(null)
  })

  it("someone else drives: Ask for the wheel", () => {
    const h = renderHeader(
      session({ driver: { kind: "human", id: "user_lu", name: "Lucía", since: NOW - 5000 } }),
    )
    fireEvent.click(h.getByTestId("crew-ask"))
    expect(h.onTake).toHaveBeenCalledOnce()
  })

  it("two at once: Let them yields to the other person", () => {
    const h = renderHeader(
      session({
        driver: { kind: "human", id: "user_lu", name: "Lucía", since: NOW - 5000 },
        conflict: { ids: [ME, "user_lu"], at: NOW - 500 },
      }),
    )
    expect(h.queryByTestId("crew-header-clash")).not.toBeNull()
    fireEvent.click(h.getByTestId("crew-yield"))
    expect(h.onYield).toHaveBeenCalledWith("user_lu")
  })

  it("nobody: no wheel action, pop-out still there", () => {
    const h = renderHeader(session({ driver: { kind: "none", since: 0 } }))
    expect(h.queryByTestId("crew-take")).toBeNull()
    expect(h.queryByTestId("crew-ask")).toBeNull()
    fireEvent.click(h.getByTestId("crew-popout"))
    expect(h.onPopOut).toHaveBeenCalledOnce()
  })
})

/** The chrome follows the app theme: light tokens under a light theme (Pablo, 2026-10-31). */
describe("TerminalHeader — light mode", () => {
  function Probe() {
    const K = useK()
    return <span data-testid="probe">{`${K.rail}|${K.canvas}|${K.text}`}</span>
  }

  it("useK() answers the light set under a light theme and the dark set under dark", () => {
    const light = render(
      <TamaguiProvider config={config} defaultTheme="light">
        <Probe />
      </TamaguiProvider>,
    )
    expect(light.getByTestId("probe").textContent).toBe("#F2F0F7|#FAF9FC|#342F3D")
    light.unmount()
    const dark = render(
      <TamaguiProvider config={config} defaultTheme="dark">
        <Probe />
      </TamaguiProvider>,
    )
    expect(dark.getByTestId("probe").textContent).toBe("#121017|#0E0C12|#E9E4F1")
  })

  it("the two sets cover the same roles and the dark set is the crew original", () => {
    const dark = crewTokens("dark")
    const light = crewTokens("light")
    expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort())
    expect(dark.canvas).toBe("#0E0C12")
    expect(light.canvas).toBe("#FAF9FC")
    for (const key of Object.keys(dark) as Array<keyof typeof dark>) {
      expect(typeof light[key]).toBe("string")
      expect(light[key].length).toBeGreaterThan(0)
    }
  })

  it("renders the header under a light theme", () => {
    const s = session({ driver: { kind: "agent", id: "agent:a1", name: "Atlas", since: 0 } })
    const h = render(
      <TamaguiProvider config={config} defaultTheme="light">
        <TerminalHeader
          session={s}
          view={describeSeat(s, ME, NOW)}
          narrow={false}
          now={NOW}
          me={ME}
          copilot={{ id: "agent:a1", kind: "agent", name: "Atlas" }}
          menuOpen={false}
          onTake={vi.fn()}
          onGiveBack={vi.fn()}
          onYield={vi.fn()}
          onPopOut={vi.fn()}
          onMenu={vi.fn()}
        />
      </TamaguiProvider>,
    )
    expect(h.queryByTestId("crew-header-agent")).not.toBeNull()
  })
})
