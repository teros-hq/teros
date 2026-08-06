/**
 * Contract de mca.trello tras el port al SDK real (TER-507, batch C 1/N).
 *
 * REGRESSION del port: el MCA importaba '../mca-sdk-dist/index.js' (un dist
 * fosilizado que NO existe en el repo) → Cannot find module al arrancar, con
 * enabled: true en el manifest. Estos son los primeros tests que EJECUTAN
 * los handlers de trello (el fix de TER-474 solo arregló los datos).
 *
 * Boundary: fetch a api.trello.com con key/token como QUERY PARAMS (modelo
 * de auth de Trello) — mockeado con Response nativa.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { createTrelloClient, trelloRequest } from "../../src/client"

const tools = await import("../../src/tools")

const realFetch = globalThis.fetch
let requests: Array<{ url: string; init: RequestInit }> = []
let nextResponse: () => Response = () => new Response(JSON.stringify({ ok: true }), { status: 200 })

beforeAll(() => {
  // biome-ignore lint/suspicious/noExplicitAny: firma compatible con fetch global
  globalThis.fetch = (async (url: any, init: any) => {
    requests.push({ url: String(url), init })
    return nextResponse()
  }) as typeof fetch
})

afterEach(() => {
  requests = []
  nextResponse = () => new Response(JSON.stringify({ ok: true }), { status: 200 })
})

afterAll(() => {
  globalThis.fetch = realFetch
})

const SECRETS = { TRELLO_API_KEY: "k_test", TRELLO_TOKEN: "t_test" }
// biome-ignore lint/suspicious/noExplicitAny: context fake con la superficie usada
const ctx: any = { execution: {}, getUserSecrets: async () => SECRETS }

describe("createTrelloClient", () => {
  it.each([
    [{}],
    [{ TRELLO_API_KEY: "k" }],
    [{ TRELLO_TOKEN: "t" }],
  ])("credenciales incompletas %j → throw exacto", (secrets) => {
    expect(() => createTrelloClient(secrets)).toThrow(
      "Trello credentials not configured. Missing TRELLO_API_KEY or TRELLO_TOKEN.",
    )
  })

  it("completas → {apiKey, token, baseUrl}", () => {
    expect(createTrelloClient(SECRETS)).toEqual({
      apiKey: "k_test",
      token: "t_test",
      baseUrl: "https://api.trello.com/1",
    })
  })
})

describe("trelloRequest — boundary HTTP", () => {
  const client = createTrelloClient(SECRETS)

  it("GET: key/token como query params, sin body", async () => {
    await trelloRequest(client, "/members/me")
    const url = new URL(requests[0].url)
    expect(url.origin + url.pathname).toBe("https://api.trello.com/1/members/me")
    expect(url.searchParams.get("key")).toBe("k_test")
    expect(url.searchParams.get("token")).toBe("t_test")
    expect(requests[0].init.method).toBe("GET")
    expect(requests[0].init.body).toBeUndefined()
  })

  it("POST con body JSON exacto", async () => {
    await trelloRequest(client, "/boards", "POST", { name: "Tablero", defaultLists: true })
    expect(requests[0].init.method).toBe("POST")
    expect(JSON.parse(requests[0].init.body as string)).toEqual({
      name: "Tablero",
      defaultLists: true,
    })
    expect(requests[0].init.headers).toEqual({ "Content-Type": "application/json" })
  })

  it("GET con body accidental → el body NO viaja (gap T3: fetch lanza con GET+body)", async () => {
    await trelloRequest(client, "/members/me", "GET", { ignorado: true })
    expect(requests[0].init.body).toBeUndefined()
  })

  it("error upstream → throw con status, statusText y body literal", async () => {
    nextResponse = () =>
      new Response("invalid id", { status: 400, statusText: "Bad Request" })
    await expect(trelloRequest(client, "/cards/xxx")).rejects.toThrow(
      "Trello API error: 400 Bad Request\ninvalid id",
    )
  })
})

describe("handlers portados — payload exacto al wire", () => {
  it("list-boards: filter en el endpoint + content MCP con el JSON del upstream", async () => {
    const boards = [{ id: "b1", name: "Tablero" }]
    nextResponse = () => new Response(JSON.stringify(boards), { status: 200 })
    const result = (await tools.listBoards.handler({ filter: "starred" }, ctx)) as {
      content: Array<{ type: string; text: string }>
    }
    expect(new URL(requests[0].url).pathname).toBe("/1/members/me/boards")
    expect(new URL(requests[0].url).searchParams.get("filter")).toBe("starred")
    expect(result.content[0].type).toBe("text")
    expect(JSON.parse(result.content[0].text)).toEqual(boards)
  })

  it("list-boards: default filter=open (el SDK no aplica defaults del schema)", async () => {
    await tools.listBoards.handler({}, ctx)
    expect(new URL(requests[0].url).searchParams.get("filter")).toBe("open")
  })

  it("create-board: POST /boards con body exacto (opcionales solo si presentes)", async () => {
    await tools.createBoard.handler({ name: "Sprint", desc: "Q3" }, ctx)
    expect(requests[0].init.method).toBe("POST")
    expect(JSON.parse(requests[0].init.body as string)).toEqual({
      name: "Sprint",
      defaultLists: true,
      desc: "Q3",
    })
  })

  it("delete-board: method DELETE al endpoint del id", async () => {
    await tools.deleteBoard.handler({ boardId: "b9" }, ctx)
    expect(requests[0].init.method).toBe("DELETE")
    expect(new URL(requests[0].url).pathname).toBe("/1/boards/b9")
  })

  it("search: query con encodeURIComponent + modelTypes/partial defaults", async () => {
    await tools.search.handler({ query: "tarea año/2" }, ctx)
    // el constructor URL re-serializa %20 como + (equivalente en query) —
    // pin por VALOR decodificado, no por encoding literal
    const url = new URL(requests[0].url)
    expect(url.pathname).toBe("/1/search")
    expect(url.searchParams.get("query")).toBe("tarea año/2")
    expect(url.searchParams.get("modelTypes")).toBe("cards")
    expect(url.searchParams.get("partial")).toBe("false")
  })

  it("search: query con '&' sobrevive intacto (gap T10: sin encode, '&' parte los params)", async () => {
    await tools.search.handler({ query: "presupuesto&sprint=3" }, ctx)
    const url = new URL(requests[0].url)
    expect(url.searchParams.get("query")).toBe("presupuesto&sprint=3")
    expect(url.searchParams.get("modelTypes")).toBe("cards")
  })

  it("update-card: PUT con solo los campos presentes", async () => {
    await tools.updateCard.handler({ cardId: "c1", name: "Nuevo título" }, ctx)
    expect(requests[0].init.method).toBe("PUT")
    expect(new URL(requests[0].url).pathname).toBe("/1/cards/c1")
    expect(JSON.parse(requests[0].init.body as string)).toEqual({ name: "Nuevo título" })
  })

  it("secrets incompletos → el throw del client llega al agente", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: context fake
    const badCtx: any = { execution: {}, getUserSecrets: async () => ({}) }
    await expect(tools.listBoards.handler({}, badCtx)).rejects.toThrow(
      "Trello credentials not configured",
    )
    expect(requests).toEqual([])
  })
})
