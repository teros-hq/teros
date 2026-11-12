/**
 * A tiny Anthropic-compatible Messages API for terminal smokes: lets the real
 * Claude Code TUI run a whole turn with no credentials and no network.
 *
 * Every POST /v1/messages gets one canned assistant text: "FAKE_MODEL_OK: <n>"
 * where <n> is the product of the first "A*B" / "A x B" found in the last user
 * message (else 0) — so a smoke can check the answer reached the screen.
 * Streaming (SSE) and non-streaming requests are both served; anything else
 * is a 404 Claude Code tolerates (it only needs messages to work).
 *
 *   npx tsx scripts/smoke-terminal-fake-anthropic.mts [port]   # standalone
 */

import { createServer, type IncomingMessage, type Server } from "node:http"

export interface FakeAnthropic {
  port: number
  /** Requests served so far (for assertions). */
  requests: number
  /** Bash tool calls handed to Claude Code. */
  toolCalls: number
  /** The user's prompts in the last conversation request (one with tools): a resumed session carries the old ones. */
  conversation: string[]
  close(): Promise<void>
}

/** Every user prompt of a request, oldest first (system reminders and tool results left out). */
function userTexts(body: any): string[] {
  const out: string[] = []
  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    if (m?.role !== "user") continue
    const parts =
      typeof m.content === "string"
        ? [m.content]
        : Array.isArray(m.content)
          ? m.content.filter((c: any) => c?.type === "text").map((c: any) => String(c.text))
          : []
    for (const t of parts) if (!t.trimStart().startsWith("<system-reminder>")) out.push(t)
  }
  return out
}

function lastUserText(body: any): string {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== "user") continue
    if (typeof m.content === "string") return m.content
    if (Array.isArray(m.content)) {
      const texts = m.content
        .filter((c: any) => c?.type === "text" && typeof c.text === "string")
        .map((c: any) => c.text as string)
        // Claude Code prepends <system-reminder> blocks: the prompt is the last text.
        .filter((t: string) => !t.trimStart().startsWith("<system-reminder>"))
      if (texts.length) return texts[texts.length - 1]
    }
  }
  return ""
}

/** The last user message carries a tool result (Claude Code ran the tool we asked for). */
function lastIsToolResult(body: any): boolean {
  // Claude Code appends a system-role message after the user's: look past it.
  const messages = (Array.isArray(body?.messages) ? body.messages : []).filter(
    (m: any) => m?.role !== "system",
  )
  const last = messages[messages.length - 1]
  return (
    last?.role === "user" &&
    Array.isArray(last.content) &&
    last.content.some((c: any) => c?.type === "tool_result")
  )
}

/** Marker in a prompt that makes the fake call Claude Code's Bash tool (`FAKE_TOOL_COMMAND`). */
export const RUN_TOOL_MARKER = "RUN_BASH_TOOL"
export const FAKE_TOOL_COMMAND = "sleep 4 && echo FAKE_TOOL_DONE"

export function fakeAnswer(prompt: string): string {
  const m = prompt.match(/(\d+)\s*(?:\*|x|×|times)\s*(\d+)/i)
  const n = m ? Number(m[1]) * Number(m[2]) : 0
  return `FAKE_MODEL_OK: ${n}`
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ""
    req.on("data", (c) => {
      data += c
    })
    req.on("end", () => resolve(data))
  })
}

/** Stream one Bash tool_use (stop_reason tool_use), the way the API does. */
function sendToolUse(res: import("node:http").ServerResponse, id: string, model: string): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  const send = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  const input = JSON.stringify({
    command: FAKE_TOOL_COMMAND,
    description: "Wait, then print a marker",
  })
  send("message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  })
  send("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: `toolu_${id}`, name: "Bash", input: {} },
  })
  send("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: input },
  })
  send("content_block_stop", { type: "content_block_stop", index: 0 })
  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 20 },
  })
  send("message_stop", { type: "message_stop" })
  res.end()
}

export async function startFakeAnthropic(port = 0): Promise<FakeAnthropic> {
  const state = { requests: 0, toolCalls: 0, conversation: [] as string[] }
  const server: Server = createServer(async (req, res) => {
    const url = req.url ?? ""
    if (req.method !== "POST" || !url.startsWith("/v1/messages")) {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: url } }))
      return
    }
    const raw = await readBody(req)
    let body: any = {}
    try {
      body = JSON.parse(raw)
    } catch {
      /* empty body */
    }
    if (url.startsWith("/v1/messages/count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ input_tokens: 10 }))
      return
    }
    state.requests++
    const prompt = lastUserText(body)
    if (Array.isArray(body.tools) && body.tools.length) state.conversation = userTexts(body)
    if (process.env.FAKE_ANTHROPIC_LOG) {
      const sys = Array.isArray(body.system)
        ? body.system.map((b: any) => b?.text ?? "").join(" ")
        : String(body.system ?? "")
      const last = body.messages?.[body.messages.length - 1]
      const kinds = Array.isArray(last?.content)
        ? last.content.map((c: any) => c?.type).join(",")
        : typeof last?.content
      console.log(
        `[fake] #${state.requests} model=${body.model} tools=${(body.tools ?? []).length} msgs=${body.messages?.length} last=${last?.role}:${kinds} sys="${sys.slice(0, 90).replace(/\s+/g, " ")}"`,
      )
    }
    const hasBash = Array.isArray(body.tools) && body.tools.some((t: any) => t?.name === "Bash")
    const toolResult = lastIsToolResult(body)
    const callTool = hasBash && !toolResult && prompt.includes(RUN_TOOL_MARKER)
    const text = toolResult ? "FAKE_MODEL_OK: the command finished" : fakeAnswer(prompt)
    const model = String(body.model ?? "claude-fake")
    const id = `msg_fake_${state.requests}`
    const usage = { input_tokens: 10, output_tokens: 5 }
    if (callTool) {
      state.toolCalls++
      sendToolUse(res, id, model)
      return
    }
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          id,
          type: "message",
          role: "assistant",
          model,
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage,
        }),
      )
      return
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    const send = (event: string, data: unknown) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    send("message_start", {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    })
    send("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    })
    send("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    })
    send("content_block_stop", { type: "content_block_stop", index: 0 })
    send("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 },
    })
    send("message_stop", { type: "message_stop" })
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(port, "0.0.0.0", resolve))
  const address = server.address()
  const actual = typeof address === "object" && address ? address.port : port
  return {
    port: actual,
    get requests() {
      return state.requests
    },
    get toolCalls() {
      return state.toolCalls
    },
    get conversation() {
      return state.conversation
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fake = await startFakeAnthropic(Number(process.argv[2]) || 0)
  console.log(`fake Anthropic API on :${fake.port}`)
}
