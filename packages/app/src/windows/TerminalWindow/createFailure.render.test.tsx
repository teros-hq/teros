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

import { createFailureOf, createFailureReason, emptyViewOf } from "./createFailure"
import { TerminalCreateFailed } from "./TerminalCreateFailed"
import type { SharedOffer } from "./terminalWindowModel"

const FILLED = "rgb(111, 39, 255)"
const PLAIN = "rgba(0, 0, 0, 0)"

const ui = (screen: ReactElement) =>
  render(
    <TamaguiProvider config={config} defaultTheme="dark">
      {screen}
    </TamaguiProvider>,
  )

const failed = (code: string, offer?: SharedOffer) =>
  ui(
    <TerminalCreateFailed
      failure={{ terminalId: "t1", code }}
      onRetry={() => {}}
      onSessions={() => {}}
      onPersonal={() => {}}
      offer={offer}
    />,
  )

const t = ((key: string, o?: Record<string, string>) =>
  (o?.defaultValue ?? key).replace(
    /\{\{(\w+)\}\}/g,
    (_m, k: string) => o?.[k] ?? "",
  )) as unknown as TFunction

const coded = (code: string, message: string) => Object.assign(new Error(message), { code })

describe("a terminal that could not be created", () => {
  it("[TW-AC-26] a refused create is a failure of this window's session, with the backend's code", () => {
    expect(createFailureOf("t1", coded("FORBIDDEN_APP", "nope"))).toEqual({
      terminalId: "t1",
      code: "FORBIDDEN_APP",
    })
    expect(createFailureOf("t1", new Error("Request timeout after 120000ms")).code).toBe("TIMEOUT")
    expect(createFailureOf("t1", "boom").code).toBe("UNKNOWN")
  })

  it("[TW-AC-26] the window shows the failure, and 'not here' only when nothing failed", () => {
    const failure = { terminalId: "t1", code: "UNKNOWN" }
    expect(emptyViewOf({ terminalId: "t1", opening: false, failure })).toBe("create-failed")
    expect(emptyViewOf({ terminalId: "t1", opening: true, failure })).toBe("create-failed")
    expect(emptyViewOf({ terminalId: "t1", opening: false, failure: null })).toBe("gone")
    expect(emptyViewOf({ terminalId: "t1", opening: true, failure: null })).toBe("opening")
    expect(emptyViewOf({ terminalId: "t2", opening: true, failure })).toBe("opening")
    expect(emptyViewOf({ terminalId: "t2", opening: false, failure })).toBe("gone")
  })

  it("[TW-AC-26] every failure is said in one short plain sentence, never the backend's text", () => {
    for (const code of ["TIMEOUT", "FORBIDDEN_WORKSPACE_ROLE", "FORBIDDEN_APP", "UNKNOWN", "X"]) {
      const words = createFailureReason({ code }, t)
      expect(words.length).toBeGreaterThan(10)
      expect(words.length).toBeLessThan(100)
      expect(words).not.toMatch(/machine|MCA|appId|_/)
    }
    expect(createFailureReason({ code: "TIMEOUT" }, t)).toMatch(/too long/)
    expect(createFailureReason({ code: "FORBIDDEN_WORKSPACE_ROLE" }, t)).toMatch(/write access/)
  })

  it("[TW-AC-26] the failed window says it did not open and offers to try again or pick a session", () => {
    const onRetry = vi.fn()
    const onSessions = vi.fn()
    const view = render(
      <TamaguiProvider config={config} defaultTheme="dark">
        <TerminalCreateFailed
          failure={{ terminalId: "t1", code: "TIMEOUT" }}
          onRetry={onRetry}
          onSessions={onSessions}
        />
      </TamaguiProvider>,
    )
    expect(view.queryByText("This terminal did not open")).not.toBeNull()
    expect(view.queryByText("It took too long to start. Try again.")).not.toBeNull()
    expect(view.queryByText("This session is not here")).toBeNull()
    fireEvent.click(view.getByTestId("terminal-failed-retry"))
    fireEvent.click(view.getByTestId("terminal-failed-sessions"))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onSessions).toHaveBeenCalledTimes(1)
  })
})

describe("the fix line of a personal Bash", () => {
  it("[SPACE-AC-26] the installer is told where to share the app, anyone else to ask the installer", () => {
    const mine = failed("PERSONAL_APP", { kind: "personal-bash", mine: true })
    const mineText = mine.getByTestId("terminal-create-failed").textContent ?? ""
    expect(mine.getByTestId("terminal-failed-fix").textContent).toContain(
      "My Apps → Bash → Settings",
    )
    expect(mineText.indexOf("Bash is personal here")).toBeLessThan(
      mineText.indexOf("My Apps → Bash → Settings"),
    )
    expect(mineText).toContain("Open a personal terminal")
    mine.unmount()
    const theirs = failed("PERSONAL_APP", { kind: "personal-bash", mine: false })
    expect(theirs.getByTestId("terminal-failed-fix").textContent).toContain(
      "ask the member who installed it",
    )
    expect(theirs.getByTestId("terminal-failed-fix").textContent).not.toMatch(/My Apps/)
  })
})

describe("what a failed window underscores", () => {
  it("[SPACE-AC-26] with a personal Bash it is 'Open a personal terminal': retrying cannot help", () => {
    const view = failed("PERSONAL_APP", { kind: "personal-bash", mine: true })
    expect(view.getByTestId("terminal-failed-personal").style.backgroundColor).toBe(FILLED)
    expect(view.getByTestId("terminal-failed-retry").style.backgroundColor).toBe(PLAIN)
  })

  it("[TW-AC-26] any other failure keeps 'Try again' and says no fix line", () => {
    const view = failed("TIMEOUT")
    expect(view.getByTestId("terminal-failed-retry").style.backgroundColor).toBe(FILLED)
    expect(view.getByTestId("terminal-failed-personal").style.backgroundColor).toBe(PLAIN)
    expect(view.queryByTestId("terminal-failed-fix")).toBeNull()
    expect(view.getByTestId("terminal-create-failed").textContent).not.toMatch(
      /My Apps|ask the member/,
    )
  })
})
