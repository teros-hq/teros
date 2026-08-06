/**
 * Contract de mca.teros.holded (TER-502, batch B 6/N).
 *
 * Boundary: fetch a https://api.holded.com con auth header `key:` — mockeado
 * con Response nativa. El client reintenta 429 (honra Retry-After) y 5xx con
 * backoff exponencial REAL (sleeps de ~1s en los tests de retry) y aplica un
 * throttle module-level de 200ms entre requests.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"

const tools = await import("../../src/tools")

const realFetch = globalThis.fetch
let requests: Array<{ url: string; init: RequestInit }> = []
let responseQueue: Array<() => Response> = []
const okJson = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 })

beforeAll(() => {
  // biome-ignore lint/suspicious/noExplicitAny: firma compatible con fetch global
  globalThis.fetch = (async (url: any, init: any) => {
    requests.push({ url: String(url), init })
    const next = responseQueue.shift()
    if (!next) throw new Error("response queue agotada — test mal configurado")
    return next()
  }) as typeof fetch
})

afterEach(() => {
  requests = []
  responseQueue = []
})

afterAll(() => {
  globalThis.fetch = realFetch
})

// biome-ignore lint/suspicious/noExplicitAny: context fake con la superficie usada
function ctx(secrets: Record<string, string | undefined> = { HOLDED_API_KEY: "hk_test" }): any {
  return { execution: {}, getUserSecrets: async () => secrets }
}

describe("holdedRequest — boundary HTTP", () => {
  it("sin HOLDED_API_KEY → throw exacto sin tocar la red", async () => {
    await expect(tools.listContacts.handler({}, ctx({}))).rejects.toThrow(
      "Holded API key not configured. Please set your HOLDED_API_KEY in the app settings.",
    )
    expect(requests).toEqual([])
  })

  it("header key + Content-Type + Accept exactos; GET sin body", async () => {
    responseQueue = [okJson([])]
    await tools.listContacts.handler({}, ctx())
    expect(requests[0].init.headers).toEqual({
      key: "hk_test",
      "Content-Type": "application/json",
      Accept: "application/json",
    })
    expect(requests[0].init.method).toBe("GET")
    expect(requests[0].init.body).toBeUndefined()
  })

  it("429 con Retry-After → reintenta y devuelve el resultado del 2º intento", async () => {
    responseQueue = [
      () => new Response("slow down", { status: 429, headers: { "Retry-After": "1" } }),
      okJson([{ id: "c1", name: "Acme" }]),
    ]
    const result = (await tools.listContacts.handler({}, ctx())) as {
      contacts: Array<{ id: string | null }>
    }
    expect(requests.length).toBe(2)
    expect(result.contacts[0].id).toBe("c1")
  }, 10000)

  it("5xx → retry exponencial y éxito al 2º intento", async () => {
    responseQueue = [() => new Response("oops", { status: 502 }), okJson([])]
    const result = await tools.listContacts.handler({}, ctx())
    expect(requests.length).toBe(2)
    expect((result as { count: number }).count).toBe(0)
  }, 10000)

  it("4xx no-retry → message del JSON de error (message||error||text)", async () => {
    responseQueue = [
      () => new Response(JSON.stringify({ message: "Invalid contact id" }), { status: 400 }),
    ]
    await expect(tools.getContact.handler({ id: "x" }, ctx())).rejects.toThrow(
      "Holded API error 400: Invalid contact id",
    )
    expect(requests.length).toBe(1)
  })

  it("4xx con body no-JSON → texto crudo", async () => {
    responseQueue = [() => new Response("plain failure", { status: 403 })]
    await expect(tools.getContact.handler({ id: "x" }, ctx())).rejects.toThrow(
      "Holded API error 403: plain failure",
    )
  })

  it("204 No Content → {success: true} (gap del hunt H6; path para futuros writes)", async () => {
    const { holdedRequest } = await import("../../src/lib/holded-client")
    responseQueue = [() => new Response(null, { status: 204 })]
    const result = await holdedRequest(ctx(), "/invoicing/v1/contacts/c1", { method: "DELETE" })
    expect(result).toEqual({ success: true })
  })
})

describe("list-contacts", () => {
  it("params exactos en el wire (page/limit defaults + type condicional)", async () => {
    responseQueue = [okJson([])]
    await tools.listContacts.handler({}, ctx())
    const url = new URL(requests[0].url)
    expect(url.pathname).toBe("/api/invoicing/v1/contacts")
    expect(Object.fromEntries(url.searchParams)).toEqual({ page: "1", limit: "25" })

    responseQueue = [okJson([])]
    await tools.listContacts.handler({ page: 2, limit: 5, type: "client" }, ctx())
    expect(Object.fromEntries(new URL(requests[1].url).searchParams)).toEqual({
      page: "2",
      limit: "5",
      type: "client",
    })
  })

  it("mapping con ?? null: fixture COMPLETO conserva valores; vacío → todo null", async () => {
    responseQueue = [
      okJson([
        {
          id: "c1",
          name: "Acme",
          email: "a@acme.es",
          phone: "911",
          mobile: "600",
          type: "client",
          code: "ACM",
          tradeName: "Acme SL",
          address: "C/ Mayor 1",
          city: "Madrid",
          zip: "28001",
          country: "ES",
          vatNumber: "B123",
          createdAt: 1700000000,
          updatedAt: 1700000001,
          extra_ignorado: "fuera",
        },
        {},
      ]),
    ]
    const result = (await tools.listContacts.handler({}, ctx())) as {
      count: number
      contacts: Array<Record<string, unknown>>
    }
    expect(result.contacts[0]).toEqual({
      id: "c1",
      name: "Acme",
      email: "a@acme.es",
      phone: "911",
      mobile: "600",
      type: "client",
      code: "ACM",
      tradeName: "Acme SL",
      address: "C/ Mayor 1",
      city: "Madrid",
      zip: "28001",
      country: "ES",
      vatNumber: "B123",
      createdAt: 1700000000,
      updatedAt: 1700000001,
    })
    // upstream vacío → whitelist completa con null (contrato estable para el renderer)
    for (const value of Object.values(result.contacts[1])) {
      expect(value).toBeNull()
    }
  })

  it("upstream no-array → lista vacía sin crash", async () => {
    responseQueue = [okJson({ unexpected: "shape" })]
    const result = (await tools.listContacts.handler({}, ctx())) as {
      count: number
      contacts: unknown[]
    }
    expect(result.contacts).toEqual([])
    expect(result.count).toBe(0)
  })
})

describe("get-contact", () => {
  it("encodeURIComponent del id (path traversal del id imposible)", async () => {
    responseQueue = [okJson({ id: "a/b" })]
    await tools.getContact.handler({ id: "a/b" }, ctx())
    expect(new URL(requests[0].url).pathname).toBe("/api/invoicing/v1/contacts/a%2Fb")
  })

  it("whitelist exacta del detail (16 campos, ?? null)", async () => {
    responseQueue = [okJson({ id: "c1", name: "Acme", interno: "no-va" })]
    const result = (await tools.getContact.handler({ id: "c1" }, ctx())) as Record<string, unknown>
    expect(Object.keys(result).sort()).toEqual(
      [
        "id",
        "name",
        "email",
        "phone",
        "mobile",
        "type",
        "code",
        "tradeName",
        "address",
        "city",
        "zip",
        "country",
        "vatNumber",
        "customFields",
        "createdAt",
        "updatedAt",
      ].sort(),
    )
    expect(result.interno).toBeUndefined()
  })
})

describe("list-invoices", () => {
  it("params: status y contactId (renombrado a contact) condicionales", async () => {
    responseQueue = [okJson([])]
    await tools.listInvoices.handler({ status: "paid", contactId: "c9" }, ctx())
    expect(Object.fromEntries(new URL(requests[0].url).searchParams)).toEqual({
      page: "1",
      limit: "25",
      status: "paid",
      contact: "c9",
    })
    expect(new URL(requests[0].url).pathname).toBe("/api/invoicing/v1/documents/invoice")
  })
})

describe("health-check", () => {
  it("sin key → AUTH_REQUIRED user_action (sin red)", async () => {
    const result = (await tools.healthCheck.handler({}, ctx({}))) as {
      status: string
      issues: Array<{ code: string }>
    }
    expect(result.status).toBe("not_ready")
    expect(result.issues[0].code).toBe("AUTH_REQUIRED")
    expect(requests).toEqual([])
  })

  it("validateCredentials OK → ready con params limit=1", async () => {
    responseQueue = [okJson([])]
    const result = (await tools.healthCheck.handler({}, ctx())) as { status: string }
    expect(result.status).toBe("ready")
    expect(Object.fromEntries(new URL(requests[0].url).searchParams)).toEqual({ limit: "1" })
  })

  it("401 → AUTH_INVALID user_action", async () => {
    responseQueue = [() => new Response("unauthorized", { status: 401 })]
    const result = (await tools.healthCheck.handler({}, ctx())) as {
      issues: Array<{ code: string }>
    }
    expect(result.issues[0].code).toBe("AUTH_INVALID")
  })
})
