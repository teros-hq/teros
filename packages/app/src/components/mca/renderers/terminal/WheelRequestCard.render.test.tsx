import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { TamaguiProvider } from "tamagui"
import { beforeEach, describe, expect, it, vi } from "vitest"
import config from "../../../../../tamagui.config"

const client = vi.hoisted(() => {
  const state = { calls: [] as Array<[string, string, unknown]>, fail: null as string | null }
  return {
    state,
    send: async (to: string, action: string, data: unknown) => {
      state.calls.push([to, action, data])
      if (state.fail) throw new Error(state.fail)
      return { ok: true }
    },
  }
})
vi.mock("../../../../services/terosClientSingleton", () => ({
  getTerosClient: () => client,
}))

import { controlAnswererOf, WheelRequestCard } from "./WheelRequestCard"

const request = { agent: { id: "agent_atlas", name: "Atlas" }, reason: "run the tests", at: 1 }

function renderCard(props: Partial<Parameters<typeof WheelRequestCard>[0]> = {}) {
  return render(
    <TamaguiProvider config={config} defaultTheme="dark">
      <WheelRequestCard
        terminalId="t1"
        sessionName="Shell 1"
        request={request}
        canAnswer
        {...props}
      />
    </TamaguiProvider>,
  )
}

beforeEach(() => {
  client.state.calls = []
  client.state.fail = null
})

describe("the request card: an agent asks to use a session [TW-AC-13]", () => {
  it("names the agent and the session, and whose session it is", async () => {
    const { unmount } = renderCard({ opener: "you" })
    const card = await screen.findByTestId("control-request")
    expect(card.textContent).toContain("Atlas asks to use Shell 1")
    expect(screen.getByTestId("control-request-opener").textContent).toBe(" · opened by you")
    unmount()
    renderCard({ opener: "member" })
    expect((await screen.findByTestId("control-request-opener")).textContent).toBe(
      " · opened by another member",
    )
  })

  it("says why the agent asks", async () => {
    renderCard()
    expect((await screen.findByTestId("control-request")).textContent).toContain("run the tests")
  })

  it("the two answers are Allow and Keep off", async () => {
    renderCard()
    expect((await screen.findByTestId("control-request-allow")).textContent).toBe("Allow")
    expect(screen.getByTestId("control-request-deny").textContent).toBe("Keep off")
  })

  it("Allow approves that agent's request, the buttons go and the card says the agent can type", async () => {
    renderCard()
    fireEvent.click(await screen.findByTestId("control-request-allow"))
    await waitFor(() =>
      expect(client.state.calls).toEqual([
        ["terminal", "answerWheel", { terminalId: "t1", approve: true, agentId: "agent_atlas" }],
      ]),
    )
    await waitFor(() => expect(screen.queryByTestId("control-request-allow")).toBeNull())
    expect(screen.getByTestId("control-request").textContent).toContain("Atlas can type now.")
  })

  it("Keep off denies it, and the card says Agent stayed off", async () => {
    renderCard()
    fireEvent.click(await screen.findByTestId("control-request-deny"))
    await waitFor(() =>
      expect(client.state.calls).toEqual([
        ["terminal", "answerWheel", { terminalId: "t1", approve: false, agentId: "agent_atlas" }],
      ]),
    )
    await waitFor(() =>
      expect(screen.getByTestId("control-request").textContent).toContain("You kept Agent off."),
    )
    expect(screen.queryByTestId("control-request-deny")).toBeNull()
  })

  it("a refused answer (STALE) keeps the buttons and shows the error in the danger tone", async () => {
    client.state.fail = "STALE"
    renderCard()
    fireEvent.click(await screen.findByTestId("control-request-allow"))
    const error = await screen.findByTestId("control-request-error")
    expect(error.textContent).toBe("STALE")
    expect(screen.queryByTestId("control-request-allow")).not.toBeNull()
  })

  it("once answered elsewhere, the card stays and says how it ended, with no buttons", async () => {
    const { unmount } = renderCard({ request: null, answeredAs: "approved", agentName: "Atlas" })
    const card = await screen.findByTestId("control-request")
    expect(card.textContent).toContain("Atlas can type now.")
    expect(screen.queryByTestId("control-request-allow")).toBeNull()
    unmount()
    renderCard({ request: null, answeredAs: "denied" })
    expect((await screen.findByTestId("control-request")).textContent).toContain(
      "You kept Agent off.",
    )
  })

  it("answered with no known outcome (no request any more): Answered, and no buttons", async () => {
    renderCard({ request: null })
    expect((await screen.findByTestId("control-request")).textContent).toContain("Answered.")
    expect(screen.queryByTestId("control-request-allow")).toBeNull()
    expect(screen.queryByTestId("control-request-deny")).toBeNull()
  })

  it("an agent with no name is An agent", async () => {
    renderCard({ request: { agent: { id: "agent_x" }, reason: null, at: 1 } })
    expect((await screen.findByTestId("control-request")).textContent).toContain(
      "An agent asks to use Shell 1",
    )
  })
})

describe("who sees the buttons [TW-AC-13]", () => {
  it("a read member sees the request but cannot answer it", async () => {
    renderCard({ canAnswer: false })
    const card = await screen.findByTestId("control-request")
    expect(screen.queryByTestId("control-request-allow")).toBeNull()
    expect(card.textContent).toContain("Someone with write access to this workspace can answer it.")
  })

  it("while another person types there, only they answer: no buttons, and the card says who", async () => {
    renderCard({ answerer: { by: "typist", name: "Iria" } })
    const card = await screen.findByTestId("control-request")
    expect(screen.queryByTestId("control-request-allow")).toBeNull()
    expect(card.textContent).toContain("Iria is typing there: only they can answer.")
    expect(card.textContent).not.toContain("Someone with write access")
  })

  it("nobody types in a session another member opened: only its opener answers", async () => {
    renderCard({ answerer: { by: "opener" }, opener: "member" })
    const card = await screen.findByTestId("control-request")
    expect(screen.queryByTestId("control-request-allow")).toBeNull()
    expect(card.textContent).toContain("Only the person who opened this session can answer.")
  })
})

describe("controlAnswererOf: who else must answer [TW-AC-12]", () => {
  const human = (id: string) => ({
    kind: "human" as const,
    id,
    name: id === "u_iria" ? "Iria Souto" : "Me",
    since: Date.now(),
  })
  const nobody = { kind: "none" as const, since: 0 }
  const agent = { kind: "agent" as const, id: "agent_rex", since: 0 }

  it("the person typing there answers it, whoever opened the session", () => {
    expect(
      controlAnswererOf({ driver: human("u_me"), createdBy: "u_iria", space: "shared" }, "u_me"),
    ).toBeNull()
    expect(
      controlAnswererOf({ driver: human("u_iria"), createdBy: "u_me", space: "shared" }, "u_me"),
    ).toEqual({
      by: "typist",
      name: "Iria",
    })
  })

  it("when no person types: the person who opened it answers", () => {
    expect(controlAnswererOf({ driver: nobody, createdBy: "u_me" }, "u_me")).toBeNull()
    expect(controlAnswererOf({ driver: agent, createdBy: "u_me" }, "u_me")).toBeNull()
    expect(controlAnswererOf({ driver: nobody, createdBy: "u_iria" }, "u_me")).toEqual({
      by: "opener",
    })
    expect(controlAnswererOf({ driver: agent, createdBy: "u_iria" }, "u_me")).toEqual({
      by: "opener",
    })
  })

  it("when an agent opened it and no person types: any member who sees it answers", () => {
    expect(controlAnswererOf({ driver: nobody, createdBy: "agent:app_t" }, "u_me")).toBeNull()
    expect(controlAnswererOf({ driver: agent, createdBy: "agent:app_t" }, "u_me")).toBeNull()
  })
})

describe("the request card can take the person to the session [FLOAT-AC-17]", () => {
  it("in the Terminal window itself it offers no way to the session: it is already there", async () => {
    renderCard()
    await screen.findByTestId("control-request")
    expect(screen.queryByTestId("control-request-float")).toBeNull()
    expect(screen.queryByTestId("control-request-goto")).toBeNull()
  })

  it("in a chat or a notice it offers Float and Show the terminal next to Allow and Keep off", async () => {
    const onFloat = vi.fn()
    const onShow = vi.fn()
    renderCard({ onFloat, onShow })
    await screen.findByTestId("control-request")
    expect(screen.getByTestId("control-request-allow")).toBeTruthy()
    fireEvent.click(screen.getByTestId("control-request-float"))
    fireEvent.click(screen.getByTestId("control-request-goto"))
    expect(onFloat).toHaveBeenCalledTimes(1)
    expect(onShow).toHaveBeenCalledTimes(1)
    expect(client.state.calls).toEqual([])
  })

  it("someone who cannot answer can still go and look", async () => {
    renderCard({ onFloat: () => {}, onShow: () => {}, answerer: { by: "typist", name: "Iria" } })
    await screen.findByTestId("control-request")
    expect(screen.queryByTestId("control-request-allow")).toBeNull()
    expect(screen.getByTestId("control-request-float")).toBeTruthy()
  })

  it("once the request is over there is nothing left to open from the card", async () => {
    renderCard({ onFloat: () => {}, onShow: () => {}, request: null })
    await screen.findByTestId("control-request")
    expect(screen.queryByTestId("control-request-float")).toBeNull()
  })

  it("a notice names the workspace the session is in", async () => {
    renderCard({ workspaceName: "Acme" })
    expect((await screen.findByTestId("control-request-meta")).textContent).toBe("Acme")
  })
})
