/**
 * Contract del client de Discord (TER-488 batch A): precedencia bot>user,
 * cache por token, clasificación de errores y buildEmbed.
 */

import { beforeEach, describe, expect, it } from "bun:test"
import { buildEmbed, getDiscordSession, handleDiscordError } from "../../src/lib/discord-client"

let seq = 0
function ctx(user: Record<string, string> = {}, system: Record<string, string> = {}) {
  return {
    getSystemSecrets: async () => ({ CLIENT_ID: "cid", CLIENT_SECRET: "csec", ...system }),
    getUserSecrets: async () => user,
  }
}

beforeEach(() => {
  seq++
})

describe("getDiscordSession", () => {
  it("sin CLIENT_ID/SECRET → error de configuración", async () => {
    await expect(
      getDiscordSession({
        getSystemSecrets: async () => ({}),
        getUserSecrets: async () => ({ BOT_TOKEN: "b" }),
      }),
    ).rejects.toThrow("Discord OAuth credentials not configured")
  })

  it('sin BOT_TOKEN ni ACCESS_TOKEN → "not connected"', async () => {
    await expect(getDiscordSession(ctx({}))).rejects.toThrow(
      "Discord not connected. Please connect your Discord account.",
    )
  })

  it("BOT_TOKEN → isBot true; el bot GANA aunque haya ACCESS_TOKEN", async () => {
    const session = await getDiscordSession(
      ctx({ BOT_TOKEN: `bot_${seq}`, ACCESS_TOKEN: `user_${seq}` }),
    )
    expect(session.isBot).toBe(true)
  })

  it("solo ACCESS_TOKEN → isBot false (Bearer)", async () => {
    const session = await getDiscordSession(ctx({ ACCESS_TOKEN: `user_${seq}` }))
    expect(session.isBot).toBe(false)
  })

  it("con AMBOS tokens, el token efectivo es el del BOT (misma sesión cacheada que bot-solo)", async () => {
    // isBot no distingue qué token se usó; la identidad del cache sí: si el
    // efectivo fuera el ACCESS_TOKEN, la segunda llamada (bot-solo) crearía
    // una sesión nueva.
    const both = await getDiscordSession(
      ctx({ BOT_TOKEN: `mix_${seq}`, ACCESS_TOKEN: `user_${seq}` }),
    )
    const botOnly = await getDiscordSession(ctx({ BOT_TOKEN: `mix_${seq}` }))
    expect(botOnly).toBe(both)
  })

  it("cache por token: mismo token → misma sesión; token nuevo → sesión nueva", async () => {
    const a = await getDiscordSession(ctx({ BOT_TOKEN: `tok_${seq}` }))
    const b = await getDiscordSession(ctx({ BOT_TOKEN: `tok_${seq}` }))
    expect(b).toBe(a)
    const c = await getDiscordSession(ctx({ BOT_TOKEN: `otro_${seq}` }))
    expect(c).not.toBe(a)
  })
})

describe("handleDiscordError — clasificación por orden", () => {
  it.each([
    [
      "rate limit",
      "You are being rate limited",
      "Discord rate limit hit during op. Please retry in a moment.",
    ],
    [
      "429",
      "Request failed with status 429",
      "Discord rate limit hit during op. Please retry in a moment.",
    ],
    ["401", "HTTP 401", "Discord authentication failed during op. Please reconnect your account."],
    [
      "Unauthorized",
      "Unauthorized",
      "Discord authentication failed during op. Please reconnect your account.",
    ],
    [
      "403",
      "HTTP 403",
      "Discord permission denied during op. Check bot permissions or OAuth scopes.",
    ],
    [
      "Forbidden",
      "Forbidden",
      "Discord permission denied during op. Check bot permissions or OAuth scopes.",
    ],
    ["404", "HTTP 404", "Discord resource not found during op. Check IDs and names."],
    [
      "50001",
      "DiscordAPIError[50001]",
      "Discord missing access during op. The bot/user lacks required permissions.",
    ],
    [
      "50013",
      "DiscordAPIError[50013]",
      "Discord missing permissions during op. The bot needs higher role or additional permissions.",
    ],
    ["genérico", "Something broke", "Discord op failed: Something broke"],
  ])("%s → mensaje clasificado exacto", (_label, input, expected) => {
    expect(() => handleDiscordError(new Error(input as string), "op")).toThrow(expected as string)
  })

  it("no-Error → mensaje Unknown con String()", () => {
    expect(() => handleDiscordError("raro", "op")).toThrow("Unknown error during op: raro")
  })
})

describe("buildEmbed", () => {
  it("solo incluye los campos provistos", () => {
    expect(buildEmbed({ title: "T", description: "D" })).toEqual({
      title: "T",
      description: "D",
    })
  })

  it("color 0 (negro) SÍ se incluye — el check es !== undefined, no falsy", () => {
    expect(buildEmbed({ color: 0 })).toEqual({ color: 0 })
  })

  it("embed completo con todos los campos", () => {
    const full = {
      title: "T",
      description: "D",
      color: 0x5865f2,
      url: "https://x",
      timestamp: "2026-06-05T00:00:00Z",
      footer: { text: "f" },
      image: { url: "https://i" },
      thumbnail: { url: "https://t" },
      author: { name: "a" },
      fields: [{ name: "n", value: "v", inline: true }],
    }
    expect(buildEmbed(full)).toEqual(full)
  })

  it("objeto vacío → embed vacío", () => {
    expect(buildEmbed({})).toEqual({})
  })
})
