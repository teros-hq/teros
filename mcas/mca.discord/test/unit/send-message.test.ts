/**
 * Output contract de send-message (TER-488 batch A) — incluye el REGRESSION
 * del bug de allowed_mentions: el SDK no aplica los defaults del JSON Schema,
 * así que omitir mentionRoles/mentionUsers dejaba parse=[] y NINGUNA mención
 * notificaba, contradiciendo el `default: true` declarado.
 *
 * Mock de `../lib` (getDiscordSession con rest fake que captura body exacto).
 * mock.module persiste entre archivos → restore en afterAll.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test"
import { resolve } from "node:path"

const LIB_PATH = resolve(import.meta.dir, "../../src/lib/index.ts")
const realLib = await import(LIB_PATH)

const posts: Array<{ route: string; body: unknown }> = []
let postResponse: Record<string, unknown> = {}

mock.module(LIB_PATH, () => ({
  ...realLib,
  getDiscordSession: async () => ({
    isBot: true,
    rest: {
      post: async (route: string, opts: { body: unknown }) => {
        posts.push({ route, body: opts.body })
        return postResponse
      },
    },
  }),
}))

const { sendMessage } = await import("../../src/tools/send-message")

afterAll(() => {
  mock.module(LIB_PATH, () => realLib)
})

beforeEach(() => {
  posts.length = 0
  postResponse = {
    id: "msg_1",
    channel_id: "ch_1",
    content: "hola",
    timestamp: "2026-06-05T00:00:00Z",
  }
})

// biome-ignore lint/suspicious/noExplicitAny: contexto fake mínimo
const ctx = {} as any

describe("send-message — allowed_mentions (regression del default no aplicado)", () => {
  it("SIN flags: roles y users permitidos por defecto, everyone NO", async () => {
    await sendMessage.handler({ channelId: "ch_1", content: "hola @user" }, ctx)
    expect((posts[0].body as any).allowed_mentions.parse).toEqual(["roles", "users"])
  })

  it("mentionEveryone: true añade everyone", async () => {
    await sendMessage.handler({ channelId: "ch_1", content: "x", mentionEveryone: true }, ctx)
    expect((posts[0].body as any).allowed_mentions.parse).toEqual(["everyone", "roles", "users"])
  })

  it("flags explícitos a false desactivan", async () => {
    await sendMessage.handler(
      { channelId: "ch_1", content: "x", mentionRoles: false, mentionUsers: false },
      ctx,
    )
    expect((posts[0].body as any).allowed_mentions.parse).toEqual([])
  })
})

describe("send-message — body y output contract", () => {
  it("body mínimo: content + allowed_mentions, ruta del canal correcta", async () => {
    await sendMessage.handler({ channelId: "ch_1", content: "hola" }, ctx)
    expect(posts[0].route).toBe("/channels/ch_1/messages")
    expect(posts[0].body).toEqual({
      content: "hola",
      allowed_mentions: {
        parse: ["roles", "users"],
        roles: [],
        users: [],
        replied_user: false,
      },
    })
  })

  it("reply añade message_reference con channel_id", async () => {
    await sendMessage.handler({ channelId: "ch_1", content: "x", replyToMessageId: "msg_0" }, ctx)
    expect((posts[0].body as any).message_reference).toEqual({
      message_id: "msg_0",
      channel_id: "ch_1",
    })
  })

  it("embeds JSON válido se parsea; inválido → error accionable", async () => {
    await sendMessage.handler({ channelId: "ch_1", embeds: '[{"title":"T"}]' }, ctx)
    expect((posts[0].body as any).embeds).toEqual([{ title: "T" }])

    await expect(sendMessage.handler({ channelId: "ch_1", embeds: "{rotos" }, ctx)).rejects.toThrow(
      "Invalid embeds JSON",
    )
  })

  it("output contract con la URL del mensaje (guild @me para DMs)", async () => {
    const result = await sendMessage.handler({ channelId: "ch_1", content: "hola" }, ctx)
    expect(result).toEqual({
      success: true,
      id: "msg_1",
      channel_id: "ch_1",
      content: "hola",
      timestamp: "2026-06-05T00:00:00Z",
      url: "https://discord.com/channels/@me/ch_1/msg_1",
    })
  })

  it("mensaje en guild usa el guild_id en la URL", async () => {
    postResponse = { id: "m2", channel_id: "ch_2", guild_id: "g_9" }
    const result = (await sendMessage.handler({ channelId: "ch_2", content: "x" }, ctx)) as any
    expect(result.url).toBe("https://discord.com/channels/g_9/ch_2/m2")
  })
})
