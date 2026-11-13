import { fireEvent, render } from "@testing-library/react"
import type { TFunction } from "i18next"
import type { ReactElement } from "react"
import { TamaguiProvider } from "tamagui"
import { describe, expect, it, vi } from "vitest"
import config from "../../../tamagui.config"

vi.mock("react-i18next", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, o?: Record<string, string>) =>
        (o?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_m, k: string) => o?.[k] ?? ""),
    }),
  }
})
vi.mock("../../services/terosClientSingleton", () => ({ getTerosClient: () => null }))

import { SpaceChoice } from "../../components/sharing/SpaceChoice"
import { createFailureReason } from "./createFailure"
import { SessionsList } from "./SessionsList"
import { TerminalCreateFailed } from "./TerminalCreateFailed"
import { TerminalSpaceCard } from "./TerminalSpaceCard"
import {
  newTerminalEntries,
  sharedOfferNote,
  terminalMenu,
  watchConfirmText,
} from "./terminalChrome"
import type { TerminalSession } from "./terminalSessions"
import {
  inheritedSpace,
  offersPersonalAfter,
  type SharedOffer,
  sharedOfferOf,
  toolbarOf,
} from "./terminalWindowModel"

const ME = "u_me"
const t = ((key: string, o?: Record<string, string>) =>
  (o?.defaultValue ?? key).replace(
    /\{\{(\w+)\}\}/g,
    (_m, k: string) => o?.[k] ?? "",
  )) as unknown as TFunction
const ui = (node: ReactElement) =>
  render(
    <TamaguiProvider config={config} defaultTheme="dark">
      {node}
    </TamaguiProvider>,
  )
const session = (extra: Partial<TerminalSession>): TerminalSession => ({
  terminalId: "t1",
  title: "Shell 1",
  kind: "shell",
  command: "bash",
  pinned: true,
  persistent: true,
  createdBy: ME,
  createdAt: "2026-11-10T10:00:00.000Z",
  lastActivity: "2026-11-10T10:00:00.000Z",
  cols: 80,
  rows: 24,
  agentState: null,
  viewers: 0,
  watchers: [],
  driver: { kind: "none", since: 0 },
  agentControl: false,
  watchable: false,
  openedBy: "person",
  ...extra,
})
const PERSONAL: SharedOffer = { kind: "personal-bash", mine: true }
const THEIRS: SharedOffer = { kind: "personal-bash", mine: false }
const READY: SharedOffer = { kind: "ready" }
const PATH_LINE = "Needs the Bash app to be shared · My Apps → Bash → Settings"
const ASK_LINE = "Needs the Bash app to be shared · ask the member who installed it"
const actions = () => ({
  goToSession: vi.fn(),
  rename: vi.fn(),
  openNew: vi.fn(),
  openToSide: vi.fn(),
  end: vi.fn(),
})

describe("nobody gets a shared terminal they did not pick", () => {
  it("[SPACE-AC-25] next to an agent's session, a new terminal is personal: only a shared terminal a person opened hands its space down", () => {
    const agents = session({ createdBy: "agent:atlas", openedBy: "agent", space: "shared" })
    expect(inheritedSpace(agents)).toBe("personal")
    expect(inheritedSpace(session({ createdBy: "agent:atlas", openedBy: "agent" }))).toBe(
      "personal",
    )
    expect(inheritedSpace(session({ space: "shared" }))).toBe("shared")
    expect(inheritedSpace(session({ createdBy: "u_quinn", space: "shared" }))).toBe("shared")
    expect(inheritedSpace(session({}))).toBe("personal")
    expect(inheritedSpace(undefined)).toBe("personal")
  })

  it("[SPACE-AC-25] the menu of an agent's session says its side terminal will be Personal", () => {
    const agents = session({ createdBy: "agent:atlas", openedBy: "agent", space: "shared" })
    const side = terminalMenu(agents, toolbarOf(agents, ME), t, actions(), {
      me: ME,
      mac: true,
      sideSpace: inheritedSpace(agents),
    }).find((e) => e.id === "new-side")
    expect(side?.trailing).toBe("Personal")
  })
})

describe("a shared terminal where Bash is a personal app", () => {
  it("[SPACE-AC-26] the offer follows the Bash app: shared or unknown is ready, personal is not, and it knows whose it is", () => {
    expect(sharedOfferOf({ scope: "shared", installedBy: "u_quinn" }, ME)).toEqual(READY)
    expect(sharedOfferOf({ scope: "personal", installedBy: ME }, ME)).toEqual(PERSONAL)
    expect(sharedOfferOf({ scope: "personal", installedBy: "u_quinn" }, ME)).toEqual(THEIRS)
    expect(sharedOfferOf({ scope: "personal", installedBy: ME }, undefined)).toEqual(THEIRS)
    expect(sharedOfferOf(null, ME)).toEqual(READY)
    expect(sharedOfferOf({}, ME)).toEqual(READY)
  })

  it("[SPACE-AC-26] the one line says what it takes: where to change it for who installed Bash, whom to ask for anybody else, nothing when Bash is shared", () => {
    expect(sharedOfferNote(PERSONAL, t)).toBe(PATH_LINE)
    expect(sharedOfferNote(THEIRS, t)).toBe(ASK_LINE)
    expect(sharedOfferNote(THEIRS, t)).not.toMatch(/My Apps/)
    expect(sharedOfferNote(READY, t)).toBeUndefined()
    expect(sharedOfferNote(undefined, t)).toBeUndefined()
  })

  it("[SPACE-AC-26] the watch question suggests a shared terminal only where one can be opened", () => {
    expect(watchConfirmText(true, t)).toMatch(/open a shared terminal instead/)
    expect(watchConfirmText(false, t)).not.toMatch(/shared terminal/)
    expect(watchConfirmText(false, t)).toMatch(/^Let the workspace watch this terminal\?/)
  })

  it("[SPACE-AC-26] the menu's shared entry says why before the click and is disabled", () => {
    const shared = (offer?: SharedOffer) =>
      newTerminalEntries(t, actions(), true, offer).find((e) => e.id === "new-shared")
    expect(shared(READY)?.detail).toBeUndefined()
    expect(shared(READY)?.disabled).toBeFalsy()
    expect(shared()?.detail).toBeUndefined()
    expect(shared(PERSONAL)?.detail).toBe(sharedOfferNote(PERSONAL, t))
    expect(shared(PERSONAL)?.detail).toBe(PATH_LINE)
    expect(shared(PERSONAL)?.disabled).toBe(true)
    expect(shared(THEIRS)?.detail).toBe(ASK_LINE)
    expect(shared(THEIRS)?.disabled).toBe(true)
    const s = session({})
    const inMenu = terminalMenu(s, toolbarOf(s, ME), t, actions(), {
      me: ME,
      mac: true,
      sideSpace: "personal",
      sharedOffer: PERSONAL,
    }).find((e) => e.id === "new-shared")
    expect(inMenu?.disabled).toBe(true)
    expect(inMenu?.detail).toBe(PATH_LINE)
  })

  it("[SPACE-AC-26] the session list's shared row says why and asks for nothing, by click or by Enter", () => {
    const list = (offer: SharedOffer) => {
      const onNew = vi.fn()
      const view = ui(
        <SessionsList
          groups={[]}
          currentId={null}
          me={ME}
          sharedOffer={offer}
          onPick={() => {}}
          onNew={onNew}
          onClose={() => {}}
        />,
      )
      return { onNew, view, row: view.getByTestId("terminal-sessions-new-shared") }
    }
    const personal = list(PERSONAL)
    expect(personal.row.textContent).toContain("Needs the Bash app to be shared")
    expect(personal.row.getAttribute("aria-disabled")).toBe("true")
    fireEvent.click(personal.row)
    const search = personal.view.getByTestId("terminal-sessions-search")
    fireEvent.change(search, { target: { value: "shared" } })
    fireEvent.keyDown(search, { key: "Enter" })
    fireEvent.submit(search)
    expect(personal.onNew).not.toHaveBeenCalled()
    personal.view.unmount()
    const ready = list(READY)
    expect(ready.row.textContent).not.toContain("Bash")
    fireEvent.click(ready.row)
    expect(ready.onNew.mock.calls).toEqual([["shared"]])
  })

  it("[SPACE-AC-26] the space card's shared row says why and asks for nothing", () => {
    const card = (offer: SharedOffer) => {
      const onNewShared = vi.fn()
      const s = session({})
      const view = ui(
        <TerminalSpaceCard
          session={s}
          state={toolbarOf(s, ME)}
          me={ME}
          top={50}
          sharedOffer={offer}
          onLetWatch={() => {}}
          onNewShared={onNewShared}
          onClose={() => {}}
        />,
      )
      return { onNewShared, view, row: view.getByTestId("terminal-space-card-shared") }
    }
    const personal = card(PERSONAL)
    expect(personal.row.textContent).toContain("Needs the Bash app to be shared")
    expect(personal.row.getAttribute("aria-disabled")).toBe("true")
    fireEvent.click(personal.row)
    expect(personal.onNewShared).not.toHaveBeenCalled()
    personal.view.unmount()
    const ready = card(READY)
    fireEvent.click(ready.row)
    expect(ready.onNewShared).toHaveBeenCalledTimes(1)
  })

  it("[SPACE-AC-26] the launcher's question says why on its Shared option, which cannot be picked", () => {
    const onPick = vi.fn()
    const view = ui(
      <SpaceChoice
        kind="terminal"
        onPick={onPick}
        sharedNote={sharedOfferNote(PERSONAL, t)}
        sharedDisabled
      />,
    )
    const option = view.getByTestId("space-choice-shared")
    expect(option.textContent).toContain("Needs the Bash app to be shared")
    fireEvent.click(option.querySelector('[role="button"]') as Element)
    expect(option.getAttribute("aria-checked")).toBe("false")
    expect(option.getAttribute("aria-disabled")).toBe("true")
    fireEvent.click(view.getByTestId("space-choice-open"))
    expect(onPick.mock.calls).toEqual([["personal"]])
  })

  it("[SPACE-AC-26] a refused shared create is said in one short plain sentence", () => {
    const refused = createFailureReason({ code: "PERSONAL_APP" }, t)
    expect(refused).toBe("Bash is personal here, so it cannot run a shared terminal.")
    expect(refused).not.toMatch(/machine|_/)
  })

  it("[SPACE-AC-26] a personal terminal is offered after a shared create failed, or after the Bash refusal, and not otherwise", () => {
    expect(offersPersonalAfter({ code: "TIMEOUT" }, "shared")).toBe(true)
    expect(offersPersonalAfter({ code: "PERSONAL_APP" }, undefined)).toBe(true)
    expect(offersPersonalAfter({ code: "TIMEOUT" }, "personal")).toBe(false)
    expect(offersPersonalAfter({ code: "TIMEOUT" }, undefined)).toBe(false)
  })

  it("[SPACE-AC-26] a shared terminal that did not open also offers a personal one", () => {
    const onPersonal = vi.fn()
    const view = ui(
      <TerminalCreateFailed
        failure={{ terminalId: "t1", code: "PERSONAL_APP" }}
        onRetry={() => {}}
        onSessions={() => {}}
        onPersonal={onPersonal}
      />,
    )
    expect(view.getByTestId("terminal-create-failed").textContent).toContain(
      "Bash is personal here",
    )
    expect(view.queryByText("This session is not here")).toBeNull()
    fireEvent.click(view.getByTestId("terminal-failed-personal"))
    expect(onPersonal).toHaveBeenCalledTimes(1)
    view.unmount()
    const plain = ui(
      <TerminalCreateFailed
        failure={{ terminalId: "t1", code: "TIMEOUT" }}
        onRetry={() => {}}
        onSessions={() => {}}
      />,
    )
    expect(plain.queryByTestId("terminal-failed-personal")).toBeNull()
  })
})
