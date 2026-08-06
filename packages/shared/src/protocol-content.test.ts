/**
 * Contract — MessageContentSchema: los 12 tipos del union + refinements
 * (TER-455). Un refine roto rompe el render de mensajes en silencio: el
 * frontend descarta el content que no parsea.
 */

import { describe, expect, it } from "bun:test"
import { MessageContentSchema, MessageSenderSchema, VoiceMessageContentSchema } from "./protocol.js"

describe("MessageContentSchema — un caso válido por tipo", () => {
  it.each([
    ["text", { type: "text", text: "hola" }],
    ["image", { type: "image", url: "https://x/i.png", width: 100, height: 50 }],
    [
      "video",
      { type: "video", url: "https://x/v.mp4", duration: 12, thumbnailUrl: "https://x/t.png" },
    ],
    ["audio", { type: "audio", url: "https://x/a.mp3", duration: 3 }],
    ["voice (url)", { type: "voice", url: "https://x/v.ogg", transcription: "hola" }],
    ["voice (data)", { type: "voice", data: "QkFTRTY0", mimeType: "audio/ogg" }],
    ["file", { type: "file", url: "https://x/f.pdf", filename: "f.pdf", size: 1024 }],
    ["html", { type: "html", html: "<b>hola</b>", height: 200 }],
    ["html_file", { type: "html_file", filePath: "/workspace/mock.html", workspaceId: "work_1" }],
    [
      "browser_live_view",
      { type: "browser_live_view", sessionId: "sess_1", url: "https://bb/live" },
    ],
    [
      "tool_execution",
      {
        type: "tool_execution",
        toolCallId: "toolu_1",
        toolName: "bash_bash",
        status: "pending_permission",
        permissionRequestId: "perm_x",
        permissionRequestedAt: "2026-06-05T00:00:00.000Z",
        appId: "app_1",
      },
    ],
    ["event", { type: "event", eventType: "wake_up", eventData: { reminderId: 4 } }],
    ["error", { type: "error", errorType: "tool", userMessage: "La tool falló" }],
  ])("parsea %s", (_label, content) => {
    const result = MessageContentSchema.safeParse(content)
    expect(result.success).toBe(true)
  })
})

describe("MessageContentSchema — rechazos clave por tipo", () => {
  it.each([
    ["text sin text", { type: "text" }],
    ["image sin url", { type: "image" }],
    ["file sin filename", { type: "file", url: "https://x/f" }],
    ["html sin html", { type: "html" }],
    ["html_file sin filePath", { type: "html_file" }],
    ["browser_live_view sin sessionId", { type: "browser_live_view", url: "https://x" }],
    [
      "tool_execution con status inválido",
      { type: "tool_execution", toolCallId: "t", toolName: "n", status: "exploded" },
    ],
    ["event sin eventData", { type: "event", eventType: "wake_up" }],
    [
      "error con errorType fuera del enum",
      { type: "error", errorType: "cosmic", userMessage: "x" },
    ],
    ["tipo desconocido", { type: "hologram", url: "https://x" }],
  ])("rechaza %s", (_label, content) => {
    expect(MessageContentSchema.safeParse(content).success).toBe(false)
  })
})

describe("VoiceMessageContentSchema — refine url||data", () => {
  it("exige al menos url o data; ambos también vale", () => {
    expect(VoiceMessageContentSchema.safeParse({ type: "voice" }).success).toBe(false)
    expect(VoiceMessageContentSchema.safeParse({ type: "voice", url: "https://x" }).success).toBe(
      true,
    )
    expect(VoiceMessageContentSchema.safeParse({ type: "voice", data: "QkFTRTY0" }).success).toBe(
      true,
    )
    expect(
      VoiceMessageContentSchema.safeParse({ type: "voice", url: "https://x", data: "QkFTRTY0" })
        .success,
    ).toBe(true)
  })

  it("el mensaje del refine es el documentado", () => {
    const result = VoiceMessageContentSchema.safeParse({ type: "voice" })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.errors[0].message).toBe("Either url or data must be provided")
    }
  })

  it("a través del UNION un voice sin url/data también se rechaza", () => {
    expect(MessageContentSchema.safeParse({ type: "voice", duration: 2 }).success).toBe(false)
  })
})

describe("MessageSenderSchema", () => {
  it("user y agent válidos; type fuera del enum rechazado", () => {
    expect(
      MessageSenderSchema.safeParse({ type: "user", id: "user_1", name: "Antonio" }).success,
    ).toBe(true)
    expect(
      MessageSenderSchema.safeParse({
        type: "agent",
        id: "agent_1",
        name: "Iria",
        avatarUrl: "https://x/a.png",
      }).success,
    ).toBe(true)
    expect(MessageSenderSchema.safeParse({ type: "system", id: "x", name: "X" }).success).toBe(
      false,
    )
  })
})
