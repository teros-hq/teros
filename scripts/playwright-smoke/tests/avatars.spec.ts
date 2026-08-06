/**
 * Avatares de agente (TER-605) — resolución de URL + upload animado, end-to-end
 * contra la API real (no mocks). Cubre los fixes del stack:
 *   - PR B (TER-607): avatarUrl se resuelve a URL pública en TODOS los boundaries
 *     de salida (create/list directos + el path de board vía resolveAgents, que la
 *     review destapó como aún roto).
 *   - PR D (TER-609): subir un GIF como avatar se acepta, persiste y se sirve como
 *     image/gif (no se recomprime → preserva la animación).
 *   - PR C (TER-608): el static serve entrega el avatar (200) con su MIME.
 *
 * Mutation check: revertir `avatarUrl: buildAvatarUrl(a.avatarUrl)` en
 * board-service.resolveAgents (o cualquier boundary) → el avatarUrl llega como
 * filename crudo (no `http…`) → el `toMatch(/^https?:\/\//)` correspondiente cae.
 *
 * Asserts a través del cliente vivo (window.teros) + page.request para HTTP.
 */
import { Buffer } from "node:buffer"
import { expect, test } from "../fixtures"
import { evalTeros, getPrimaryIds } from "../helpers/teros"

const ABS_URL = /^https?:\/\//

test.describe("avatares @avatars @agents", () => {
  test("avatarUrl se resuelve a URL pública en create + listAgents (no filename crudo)", async ({
    terosPage,
  }) => {
    const { privateWorkspaceId } = await getPrimaryIds(terosPage)
    const wid = privateWorkspaceId as string
    expect(wid, "private workspace resuelto").toBeTruthy()

    const created = await evalTeros(
      terosPage,
      async ({ wid }) => {
        const coreId = (await window.teros.agent.listAgents()).agents?.[0]?.coreId || "core:pw-test"
        const r = await window.teros.agent.createAgent({
          coreId,
          name: "PwAvatar",
          fullName: `Pw Avatar ${Date.now()}`,
          role: "tester",
          intro: "avatar resolution smoke",
          avatarUrl: "luna-avatar.jpg", // bare filename, como lo manda el frontend
          workspaceId: wid,
        })
        return { agentId: r.agent.agentId as string, avatarUrl: r.agent.avatarUrl as string }
      },
      { wid },
    )

    try {
      // create devuelve la URL ya resuelta (boundary agent.create).
      expect(created.avatarUrl, "create resuelve avatarUrl a URL absoluta").toMatch(ABS_URL)
      expect(created.avatarUrl, "termina en el filename servido").toMatch(/\/luna-avatar\.jpg$/)

      // listAgents (boundary agent.list) lo devuelve igual de resuelto.
      const listed = await evalTeros(
        terosPage,
        async ({ wid, id }) =>
          (await window.teros.agent.listAgents(wid)).agents.find((a) => a.agentId === id)?.avatarUrl,
        { wid, id: created.agentId },
      )
      expect(listed, "listAgents devuelve avatarUrl resuelto, no bare").toMatch(ABS_URL)
    } finally {
      await evalTeros(
        terosPage,
        (id) => window.teros.agent.deleteAgent(id).catch(() => null),
        created.agentId,
      )
    }
  })

  test("avatarUrl resuelto en el board (resolveAgents) — getBoard no devuelve filenames crudos", async ({
    terosPage,
  }) => {
    const { privateWorkspaceId } = await getPrimaryIds(terosPage)
    const wid = privateWorkspaceId as string
    expect(wid).toBeTruthy()

    const setup = await evalTeros(
      terosPage,
      async ({ wid }) => {
        const coreId = (await window.teros.agent.listAgents()).agents?.[0]?.coreId || "core:pw-test"
        const agentId = (
          await window.teros.agent.createAgent({
            coreId,
            name: "PwBoardAvatar",
            fullName: `Pw Board Avatar ${Date.now()}`,
            role: "tester",
            intro: "board avatar smoke",
            avatarUrl: "luna-avatar.jpg",
            workspaceId: wid,
          })
        ).agent.agentId as string

        const { project } = await window.teros.board.createProject(wid, `Avatar ${Date.now()}`)
        const task = (await window.teros.board.createTask(project.projectId, { title: "Avatar task" }))
          .task
        await window.teros.board.assignTask(task.taskId, agentId)

        const board = await window.teros.board.getBoard(project.projectId)
        // Recolectar TODA propiedad terminada en "avatarUrl" del response del board.
        const found: unknown[] = []
        const walk = (o: unknown) => {
          if (!o || typeof o !== "object") return
          for (const k of Object.keys(o as Record<string, unknown>)) {
            const v = (o as Record<string, unknown>)[k]
            if (/avatarurl$/i.test(k)) {
              if (v != null) found.push(v)
            } else {
              walk(v)
            }
          }
        }
        walk(board)
        return { projectId: project.projectId, agentId, avatars: found as string[] }
      },
      { wid },
    )

    try {
      expect(
        setup.avatars.length,
        "el board incluye al menos un avatarUrl (el agente asignado)",
      ).toBeGreaterThan(0)
      for (const a of setup.avatars) {
        expect(a, `avatarUrl del board resuelto (no crudo): ${a}`).toMatch(ABS_URL)
      }
    } finally {
      await evalTeros(
        terosPage,
        async ({ projectId, agentId }) => {
          await window.teros.board.deleteProject(projectId).catch(() => null)
          await window.teros.agent.deleteAgent(agentId).catch(() => null)
        },
        { projectId: setup.projectId, agentId: setup.agentId },
      )
    }
  })

  test("subir un GIF como avatar: se acepta, persiste resuelto y se sirve como image/gif", async ({
    terosPage,
  }) => {
    const { privateWorkspaceId } = await getPrimaryIds(terosPage)
    const wid = privateWorkspaceId as string
    expect(wid).toBeTruthy()

    const agentId = await evalTeros(
      terosPage,
      async ({ wid }) => {
        const coreId = (await window.teros.agent.listAgents()).agents?.[0]?.coreId || "core:pw-test"
        return (
          await window.teros.agent.createAgent({
            coreId,
            name: "PwGif",
            fullName: `Pw Gif ${Date.now()}`,
            role: "tester",
            intro: "gif upload smoke",
            workspaceId: wid,
          })
        ).agent.agentId as string
      },
      { wid },
    )

    try {
      const conn = await evalTeros(terosPage, () => ({
        token: window.teros.getSessionToken?.() ?? null,
        base: window.teros.getBackendBaseUrl?.() ?? null,
      }))
      expect(conn.token, "session token disponible").toBeTruthy()
      expect(conn.base, "backend base URL disponible").toBeTruthy()

      // GIF89a 1x1 válido (el contrato es aceptar image/gif y servirlo como tal sin
      // recomprimir; la animación visual la valida el smoke manual + render test).
      const gif = Buffer.from(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        "base64",
      )
      const up = await terosPage.request.post(`${conn.base}/api/upload/avatar/${agentId}`, {
        headers: { Authorization: `Bearer ${conn.token}` },
        multipart: {
          file: { name: "smoke-avatar.gif", mimeType: "image/gif", buffer: gif },
        },
      })
      expect(up.ok(), `upload responde 2xx (status ${up.status()})`).toBe(true)
      const body = (await up.json()) as { success?: boolean; url?: string }
      expect(body.success, "respuesta success").toBe(true)
      expect(body.url, "url devuelta absoluta y .gif").toMatch(/^https?:\/\/.+\.gif$/)

      // Persiste resuelto en el boundary de lectura.
      const listed = await evalTeros(
        terosPage,
        async ({ wid, id }) =>
          (await window.teros.agent.listAgents(wid)).agents.find((a) => a.agentId === id)?.avatarUrl,
        { wid, id: agentId },
      )
      expect(listed, "avatarUrl persiste resuelto y .gif").toMatch(/^https?:\/\/.+\.gif$/)

      // El static serve lo entrega como image/gif (no octet-stream, no 404).
      // GET contra el backend REAL (conn.base) usando solo el path: la URL resuelta
      // lleva config.static.baseUrl, que puede apuntar a un host no alcanzable por el
      // runner (en CI STATIC_BASE_URL=:3000 ≠ el puerto del backend → ECONNREFUSED).
      const servedUrl = `${conn.base}${new URL(listed as string).pathname}`
      const served = await terosPage.request.get(servedUrl)
      expect(served.status(), "el avatar GIF se sirve").toBe(200)
      expect(
        served.headers()["content-type"],
        "content-type image/gif (formato animado preservado)",
      ).toContain("image/gif")
    } finally {
      await evalTeros(
        terosPage,
        (id) => window.teros.agent.deleteAgent(id).catch(() => null),
        agentId,
      )
    }
  })
})
