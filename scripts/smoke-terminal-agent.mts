/**
 * Acceptance smoke: a Teros agent drives Claude Code through mca.teros.terminal
 * — tools only, no sleeps, no retries — while "the user's window" watches.
 *
 *   MONGODB_URI=mongodb://127.0.0.1:27023/?directConnection=true \
 *     npx tsx scripts/smoke-terminal-agent.mts
 *
 * Real pieces: the MCA process, the WS bridge, the terminal domain, PtyManager
 * with a real terminal host (tmux in a container cloned from the bash image),
 * the real Claude Code TUI with its hooks. The model behind Claude Code is a
 * local fake Anthropic API (scripts/smoke-terminal-fake-anthropic.mts) unless
 * SMOKE_REAL_ANTHROPIC=1 and ANTHROPIC_API_KEY are set (then the real API).
 *
 * Steps, each one tool call:
 *   0. (window path) terminal.create preset=claude on a cold host, timed, and
 *      then closed — the agent's session below must be the only one listed
 *   1. terminal-create agent=claude → Claude Code ready (window got "reveal")
 *   2. terminal-prompt (two lines) → turn done, the answer (42) on the screen
 *   3. terminal-screen onlyChanges → nothing changed since the prompt's screen
 *   4. terminal-prompt "/exit" → Claude Code left, back at the shell
 *   5. terminal-run echo → output, finished
 *   6. terminal-list → one entry per session; terminal-destroy
 * Exits 1 on any failed expectation. Removes its containers.
 *
 * Needs Docker and the bash image (IMAGE, default teros/mca-runtime-bash:terminal-gem).
 * Claude Code is installed once into SMOKE_APP_DATA (default ~/.cache/tgtools-smoke/app-data).
 */

import { spawn } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { config as dotenvConfig } from "dotenv"

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..")
dotenvConfig({ path: join(ROOT, "packages", "backend", ".env.test") })

if (!process.env.MONGODB_URI || /:27017\b/.test(process.env.MONGODB_URI)) {
  console.error("Set MONGODB_URI to a throwaway Mongo (not :27017).")
  process.exit(2)
}

import type { TestServerInstance, TestWebSocketClient } from "@teros/testing"
import type { McaHttpClient as McaHttpClientType } from "../packages/backend/src/services/mca-http-client"
import type { McaManager } from "../packages/backend/src/services/mca-manager"
import { RUN_TOOL_MARKER, startFakeAnthropic } from "./smoke-terminal-fake-anthropic.mts"

// After dotenv: the backend's config reads its env at import time.
const { createTestServer } = await import("@teros/testing")
const { McaHttpClient } = await import("../packages/backend/src/services/mca-http-client")
const { PtyManager } = await import("../packages/backend/src/services/pty-manager")
const { ProviderService } = await import("../packages/backend/src/services/provider-service")
const { runDocker, TermHostManager } = await import(
  "../packages/backend/src/services/terminal/term-host"
)

const IMAGE = process.env.IMAGE ?? "teros/mca-runtime-bash:terminal-gem"
const REAL = process.env.SMOKE_REAL_ANTHROPIC === "1" && !!process.env.ANTHROPIC_API_KEY
const APP_DATA =
  process.env.SMOKE_APP_DATA ?? join(homedir(), ".cache", "tgtools-smoke", "app-data")
const STACK = `tgsmoke-${process.pid}`
const MCA_PORT = 13_100 + Math.floor(Math.random() * 800)
const MCA_URL = `http://127.0.0.1:${MCA_PORT}`
const MCA_ENTRY = join(ROOT, "mcas", "mca.teros.terminal", "src", "index.ts")

const OWNER_EMAIL = "owner@terminal-agent-smoke.test"
const OWNER_ID = "user:test_owner" // MockAuthHandler: email → user:test_<localPart>
const WORKSPACE_ID = "work_terminal_agent_smoke"
const APP_ID = `app_tgsmoke${String(process.pid).padStart(8, "0")}`
const AGENT_ID = "agent_smoke_atlas"
const SOURCE = `mca-teros-bash-${APP_ID.replace("app_", "").slice(-8)}`

let passed = 0
let failed = 0
function step(name: string, ok: boolean, detail = ""): void {
  if (ok) passed++
  else failed++
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`)
}

let mcaHttp: McaHttpClientType
const EXEC_CONTEXT = {
  userId: OWNER_ID,
  workspaceId: WORKSPACE_ID,
  appId: APP_ID,
  agentId: AGENT_ID,
} as const

/** One tool call: the text the model reads, and the structured data. */
async function tool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; data: any }> {
  const result = await mcaHttp.callTool(name, args, EXEC_CONTEXT as any, { timeout: 125_000 })
  if (!result.success) throw new Error(`tool ${name} failed: ${JSON.stringify(result.error)}`)
  const r: any = result.result
  const text = Array.isArray(r?.content)
    ? r.content.map((c: any) => c.text ?? "").join("\n")
    : JSON.stringify(r)
  return { text, data: r?.structuredContent ?? r }
}

/** SMOKE_SCREENSHOTS=<dir>: the tool transcript and the pane (tmux grid, colours) at key moments. */
const SHOTS = process.env.SMOKE_SCREENSHOTS
const transcript: string[] = []

function show(label: string, text: string): void {
  console.log(`\n┌─ ${label}\n${text.replace(/^/gm, "│ ")}\n└─`)
  transcript.push(`▶ ${label}\n${text}\n`)
}

let paneOf: ((id: string) => { host: { container: string }; paneId: string } | undefined) | null =
  null
async function capture(name: string, terminalId: string): Promise<void> {
  if (!SHOTS || !paneOf) return
  const pane = paneOf(terminalId)
  if (!pane) return
  const r = await runDocker([
    "exec",
    pane.host.container,
    "tmux",
    "-L",
    "teros",
    "capture-pane",
    "-p",
    "-e",
    "-t",
    pane.paneId,
  ])
  writeFileSync(join(SHOTS, `${name}.ans`), r.stdout)
}

async function wsAction(
  client: TestWebSocketClient,
  action: string,
  data: unknown,
  timeoutMs = 10_000,
) {
  const requestId = `req_${Math.random().toString(36).slice(2)}`
  client.send({ type: "request", requestId, action, data })
  const response: any = await client.waitFor(
    (m: any) => (m.type === "response" || m.type === "error") && m.requestId === requestId,
    timeoutMs,
  )
  if (response.type === "error") throw new Error(`${action}: ${response.code} ${response.error}`)
  return response.data
}

async function main(): Promise<void> {
  console.log(
    `=== Smoke: a Teros agent drives Claude Code (${REAL ? "real API" : "fake API"}) ===\n`,
  )
  const fake = REAL ? null : await startFakeAnthropic()
  mkdirSync(join(APP_DATA, "home"), { recursive: true })
  // A first-time Claude Code user each run (the binary in ~/.local stays cached).
  rmSync(join(APP_DATA, "home", ".claude"), { recursive: true, force: true })
  rmSync(join(APP_DATA, "home", ".claude.json"), { force: true })
  // Claude Code in its default (auto) mode, but asking before any Bash call,
  // so the smoke goes through a real permission prompt.
  mkdirSync(join(APP_DATA, "home", ".claude"), { recursive: true })
  writeFileSync(
    join(APP_DATA, "home", ".claude", "settings.json"),
    `${JSON.stringify({ permissions: { ask: ["Bash"] } })}\n`,
  )

  const termHosts = new TermHostManager({ stackId: STACK })
  let server: TestServerInstance | undefined
  let ui: TestWebSocketClient | undefined
  let mca: ReturnType<typeof spawn> | undefined
  try {
    // ── Stand-in bash MCA container (the terminal host is cloned from it)
    const env = REAL ? [] : ["-e", `ANTHROPIC_BASE_URL=http://host.docker.internal:${fake!.port}`]
    const src = await runDocker([
      "run",
      "-d",
      "--name",
      SOURCE,
      "-v",
      `${APP_DATA}:/app-data`,
      ...env,
      "-e",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
      "-e",
      "DISABLE_AUTOUPDATER=1",
      "--entrypoint",
      "sleep",
      IMAGE,
      "infinity",
    ])
    if (src.code !== 0) throw new Error(`stand-in container: ${src.stderr}`)

    const ptyManager = new PtyManager({
      broadcastToTopic(topic: string, event: Record<string, unknown>) {
        server?.pubSubService?.broadcastToTopic(topic, event)
      },
    } as any)
    ptyManager.useTermHosts(termHosts)
    paneOf = (id) => ptyManager.paneOf(id)
    if (SHOTS) mkdirSync(SHOTS, { recursive: true })
    const mcaManager = {
      executeTool: async () => ({ output: "", isError: false }),
    } as unknown as McaManager
    const key = REAL
      ? (process.env.ANTHROPIC_API_KEY as string)
      : `sk-ant-api03-${"fake".repeat(16)}`

    server = await createTestServer({
      enableNavbarStack: true,
      enableMcaBridge: true,
      ptyManager,
      mcaManager,
      mockResponses: [{ text: "mock" }],
    } as any)
    const { db } = server
    await new ProviderService(db).addProvider(OWNER_ID, {
      providerType: "anthropic",
      displayName: "Anthropic (smoke)",
      auth: { apiKey: key },
    })
    await db.collection("workspaces").insertOne({
      workspaceId: WORKSPACE_ID,
      ownerId: OWNER_ID,
      name: "Agent smoke",
      status: "active",
      members: [{ userId: OWNER_ID, role: "admin", addedAt: new Date() }],
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    await db.collection("workspace_members").insertOne({
      workspaceId: WORKSPACE_ID,
      userId: OWNER_ID,
      role: "admin",
      status: "active",
    })
    await db.collection("users").insertOne({
      userId: OWNER_ID,
      email: OWNER_EMAIL,
      profile: { displayName: "Owner", avatarUrl: "https://example.test/owner.png" },
      role: "user",
      accessGranted: true,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    await db.collection("apps").insertOne({
      appId: APP_ID,
      mcaId: "mca.teros.terminal",
      ownerId: WORKSPACE_ID,
      ownerType: "workspace",
      name: "terminal",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    await db
      .collection("mca_catalog")
      .insertOne({ mcaId: "mca.teros.terminal", backendActions: ["terminal.*"] })
    // The Teros agent behind the tool calls: its name and avatar go on the seat.
    await db.collection("agents").insertOne({
      agentId: AGENT_ID,
      coreId: "core_smoke",
      name: "Atlas",
      fullName: "Atlas Smoke",
      avatarUrl: "atlas-avatar.jpg",
      workspaceId: WORKSPACE_ID,
    })
    await db.collection("agent_app_access").insertOne({ agentId: AGENT_ID, appId: APP_ID })

    // ── The user's Terminal window: watches the workspace's session list
    ui = await server.createClient()
    await ui.authenticate(OWNER_EMAIL)
    const events: any[] = []
    ui.getRawSocket().on("message", (raw: Buffer) => {
      const m = JSON.parse(raw.toString())
      if (m.type === "terminal_sessions") events.push(m)
    })
    await wsAction(ui, "terminal.watch", { workspaceId: WORKSPACE_ID })

    // ── 0. Window path, cold host: how long terminal.create takes
    const coldId = `t_cold_${process.pid}`
    const t0 = Date.now()
    await wsAction(
      ui,
      "terminal.create",
      { terminalId: coldId, appId: APP_ID, preset: "claude", subscribe: false },
      180_000,
    )
    const coldMs = Date.now() - t0
    step(
      "window terminal.create preset=claude on a cold host",
      true,
      `${(coldMs / 1000).toFixed(1)} s (the bash MCA warmup is stubbed here; a cold bash container adds its start)`,
    )
    await wsAction(ui, "terminal.destroy", { terminalId: coldId })

    // ── The MCA process + bridge
    const token = server.mcaConnectionManager!.registerPendingConnection(
      APP_ID,
      "mca.teros.terminal",
      WORKSPACE_ID,
    )
    mca = spawn("bun", ["run", MCA_ENTRY], {
      env: {
        ...process.env,
        PORT: String(MCA_PORT),
        MCA_WS_URL: `ws://127.0.0.1:${server.port}/mca?appId=${APP_ID}&token=${token}`,
        MCA_APP_ID: APP_ID,
        MCA_REQUIRE_SIGNATURE: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    mca.stdout!.on("data", () => {})
    mca.stderr!.on("data", () => {})
    mcaHttp = new McaHttpClient({ baseUrl: MCA_URL })
    // Process start-up is the one thing waited on by polling (it is not a tool).
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${MCA_URL}/health`)).ok) break
      } catch {}
      await new Promise((r) => setTimeout(r, 200))
    }

    // ── 1. Open Claude Code
    const created = await tool("terminal-create", { agent: "claude", title: "Smoke: Claude Code" })
    show("terminal-create agent=claude", created.text)
    const terminalId = created.data.terminalId as string
    let ready = created.data
    if (ready.status === "starting") {
      // First use installs Claude Code: the tool said what to call next.
      const w = await tool("terminal-wait", { terminalId, until: "ready", timeoutMs: 100_000 })
      show("terminal-wait until=ready", w.text)
      ready = w.data
    }
    step("Claude Code ready for a prompt", ready.reason === "ready", `reason=${ready.reason}`)
    await capture("1-ready", terminalId)
    const created1 = events.filter((e) => e.terminalId === terminalId && e.reason === "created")
    step(
      "window: one 'created' event, already persistent",
      created1.length === 1 && created1[0].session?.persistent === true,
      `${created1.length} event(s)`,
    )
    step(
      "window: asked to show the agent's session (reason 'reveal')",
      events.some((e) => e.terminalId === terminalId && e.reason === "reveal"),
    )

    // ── 2. A two-line task
    let prompt = await tool("terminal-prompt", {
      terminalId,
      text: "This is a smoke test with two lines. Do you want to proceed with it?\nWhat is 6*7? Answer with just the number.",
    })
    show("terminal-prompt", prompt.text)
    if (prompt.data.reason === "blocked" && /auto mode/i.test(prompt.data.message ?? "")) {
      // Claude Code's one-time offer to switch to auto mode: keep manual mode.
      step("Claude Code's dialog reported as blocked, with its question", true, prompt.data.message)
      // Not sent yet (the tool held the Enter back): answer, then send the typed prompt.
      const keys = prompt.data.sent === false ? ["down", "enter", "enter"] : ["down", "enter"]
      const key = await tool("terminal-send-key", { terminalId, keys })
      show(`terminal-send-key ${keys.join(" ")}`, key.text)
      prompt = await tool("terminal-wait", { terminalId, until: "turn", timeoutMs: 60_000 })
      show("terminal-wait until=turn", prompt.text)
    }
    step("turn finished (done)", prompt.data.reason === "done", `reason=${prompt.data.reason}`)
    await capture("2-answer", terminalId)
    step("multi-line prompt pasted as one message", prompt.data.pasted === true)
    step("the answer is on the screen", /\b42\b/.test(prompt.data.screen ?? ""))

    // ── 2b. A turn with a tool call: Claude Code runs Bash (4 s) — maybe after asking
    if (fake) {
      const from = events.length
      let turn = await tool("terminal-prompt", {
        terminalId,
        text: `${RUN_TOOL_MARKER}: run the check command.`,
      })
      show("terminal-prompt (tool call)", turn.text)
      if (turn.data.reason === "blocked") {
        await capture("3-permission", terminalId)
        step(
          "permission prompt reported as blocked, with the agent's words",
          !!turn.data.message,
          turn.data.message ?? "",
        )
        // The menu on screen: option 1 is "Yes".
        const key = await tool("terminal-send-key", { terminalId, keys: ["1"] })
        show("terminal-send-key 1", key.text)
        turn = await tool("terminal-wait", { terminalId, until: "turn", timeoutMs: 60_000 })
        show("terminal-wait until=turn", turn.text)
      }
      const commands = events
        .slice(from)
        .filter((e) => e.terminalId === terminalId && e.reason === "command")
        .map((e) => e.session?.command)
      step(
        "tool turn finished (done), never reported as exited",
        turn.data.reason === "done",
        `reason=${turn.data.reason}; foreground commands seen: ${commands.join(" → ") || "claude only"}`,
      )
      await capture("4-tool-done", terminalId)
      step(
        "the tool ran (its output reached the model)",
        /the command finished|FAKE_TOOL_DONE/.test(turn.data.screen ?? ""),
      )
      step("the fake handed Claude Code a tool call", fake.toolCalls === 1, `${fake.toolCalls}`)
    }

    // ── 3. Reading only what changed
    const look = await tool("terminal-screen", { terminalId, onlyChanges: true })
    show("terminal-screen onlyChanges", look.text)
    step("screen: status line names the agent state", /agent (done|idle)/.test(look.text))

    // ── 4. Leave Claude Code
    const exit = await tool("terminal-prompt", { terminalId, text: "/exit" })
    show("terminal-prompt /exit", exit.text)
    step(
      "Claude Code left, shell back",
      exit.data.reason === "exited",
      `reason=${exit.data.reason}`,
    )

    // ── 5. A shell command
    const run = await tool("terminal-run", { terminalId, command: "echo SMOKE_$((6*7))" })
    show("terminal-run", run.text)
    step(
      "terminal-run: finished with its output",
      run.data.finished === true && /^SMOKE_42$/m.test(run.data.output),
    )

    const driverEvents = events.filter((e) => e.terminalId === terminalId && e.reason === "driver")
    // terminal-create already seated it (the session is the agent's from the start).
    const firstSeat = driverEvents[0]?.session?.driver
    step(
      "the agent drives the session it opened",
      firstSeat?.kind === "agent",
      JSON.stringify(firstSeat),
    )
    const seat = driverEvents.at(-1)?.session?.driver
    step(
      "the agent's write put it on the seat (name + avatar from its agent record)",
      seat?.kind === "agent" &&
        seat.id === AGENT_ID &&
        seat.name === "Atlas" &&
        /atlas-avatar\.jpg$/.test(seat.avatarUrl ?? ""),
      JSON.stringify(seat),
    )
    // Earlier waits made it a watcher too: only this wait's announcement counts.
    const sinceWait = events.length
    const waiting = tool("terminal-wait", {
      terminalId,
      until: "text",
      text: "NEVER_ON_SCREEN",
      timeoutMs: 60_000,
    })
    // The agent shows among the watchers while it waits (the 'watchers' event).
    const isWatching = (e: any) =>
      e.terminalId === terminalId &&
      e.reason === "watchers" &&
      e.session?.watchers?.some((w: any) => w.kind === "agent" && w.id === AGENT_ID)
    // An event, not a tool: the one other thing waited on by polling.
    const watchingNow = () => events.slice(sinceWait).some(isWatching)
    for (let i = 0; i < 100 && !watchingNow(); i++) await new Promise((r) => setTimeout(r, 100))
    step("the waiting agent is among the watchers", watchingNow())
    const offAt = Date.now()
    const off = await wsAction(ui, "terminal.agentControl", { terminalId, enabled: false })
    step(
      'terminal.agentControl off ("Agent off"): the person is the one typing',
      off.agentControl === false &&
        off.driver?.kind === "human" &&
        off.driver.id === OWNER_ID &&
        off.driver.name === "Owner",
      JSON.stringify(off),
    )
    const stopped = await waiting
    show('terminal-wait (the person switched to "Agent off")', stopped.text)
    step(
      "the agent's terminal-wait returned early (reason driver)",
      stopped.data.reason === "driver" && Date.now() - offAt < 5_000,
      `reason=${stopped.data.reason} after ${Date.now() - offAt} ms`,
    )
    step(
      "…and says who switched it off",
      /Owner switched this session to "Agent off"/.test(stopped.text),
    )
    const refused = await tool("terminal-run", { terminalId, command: "echo NOPE" }).then(
      (r) => r.text,
      (e: Error) => e.message,
    )
    show("terminal-run while the person types", refused)
    step(
      "the agent's write is refused while the person types (an answer, not a failed call)",
      /^Owner is typing in this session\. Ask for control with terminal-request-control/.test(
        refused,
      ) && /Nothing was typed/.test(refused),
    )
    const sinceAsk = events.length
    const asking = tool("terminal-request-control", { terminalId, reason: "run the numbers" })
    const requested = () =>
      events
        .slice(sinceAsk)
        .some(
          (e) =>
            e.terminalId === terminalId &&
            e.reason === "wheel_request" &&
            e.session?.wheelRequest?.agent?.id === AGENT_ID,
        )
    for (let i = 0; i < 100 && !requested(); i++) await new Promise((r) => setTimeout(r, 100))
    step("the request shows on the session (with who asks)", requested())
    const allowed = await wsAction(ui, "terminal.answerWheel", { terminalId, approve: true })
    const asked = await asking
    show("terminal-request-control (allowed)", asked.text)
    step(
      '"Allow" switches the session to "Agent" for the agent at once',
      asked.data.outcome === "approved" &&
        /Owner allowed it: you have control of/.test(asked.text) &&
        allowed.driver?.kind === "agent" &&
        allowed.driver.id === AGENT_ID,
      JSON.stringify(allowed.driver),
    )
    const back = await tool("terminal-run", { terminalId, command: "echo CONTROL_$((40+2))" })
    step("the agent types again", /^CONTROL_42$/m.test(back.data.output ?? ""))

    await wsAction(ui, "terminal.agentControl", { terminalId, enabled: false })
    const gave = await wsAction(ui, "terminal.giveBack", {
      terminalId,
      note: "SMOKE: I ran the tests myself",
    })
    step(
      "the person switches Agent on again and leaves a note",
      gave.driver?.kind === "agent" && gave.driver.note === "SMOKE: I ran the tests myself",
      JSON.stringify(gave.driver),
    )
    const after = await tool("terminal-read", { terminalId, lines: 5 })
    show("terminal-read after the note", after.text)
    step(
      "the agent reads the note (handedBack)",
      after.data.handedBack?.note === "SMOKE: I ran the tests myself" &&
        /Owner switched "Agent" on again/.test(after.text),
    )
    const again = await tool("terminal-read", { terminalId, lines: 5 })
    step("…only once", !again.data.handedBack && !/switched "Agent" on again/.test(again.text))

    const personId = `t_person_${process.pid}`
    await wsAction(
      ui,
      "terminal.create",
      { terminalId: personId, appId: APP_ID, subscribe: false },
      180_000,
    )
    const hidden = await tool("terminal-list")
    step(
      'a session a person opened ("Agent off") is not in the agent\'s list',
      !hidden.data.sessions.some((s: any) => s.terminalId === personId),
    )
    const notYours = await tool("terminal-run", { terminalId: personId, command: "echo NOPE" }).then(
      (r) => r.text,
      (e: Error) => e.message,
    )
    show("terminal-run into the person's session", notYours)
    step(
      'the agent cannot reach it and is told about the "Agent" switch',
      /"Agent off"/.test(notYours) && /switch it to "Agent"/.test(notYours),
    )
    const on = await wsAction(ui, "terminal.agentControl", { terminalId: personId, enabled: true })
    step('the person switches it to "Agent"', on.agentControl === true, JSON.stringify(on))
    const listed = await tool("terminal-list")
    step(
      "now the agent lists it, as a person's private session",
      /opened by a person \(private to them\)/.test(
        listed.text.split("\n").find((l: string) => l.includes(personId)) ?? "",
      ),
    )
    const drove = await tool("terminal-run", {
      terminalId: personId,
      command: "echo PERSON_$((3*5))",
    })
    show("terminal-run (Agent on in the person's session)", drove.text)
    step("the agent types there", /^PERSON_15$/m.test(drove.data.output ?? ""))
    await wsAction(ui, "terminal.destroy", { terminalId: personId })

    // ── 6. List and close
    const list = await tool("terminal-list")
    show("terminal-list", list.text)
    const ids = (list.data.sessions as any[]).map((s) => s.terminalId)
    step(
      "terminal-list: the session once",
      ids.filter((i) => i === terminalId).length === 1,
      `${ids.length} session(s)`,
    )
    const closed = await tool("terminal-destroy", { terminalId })
    step("terminal-destroy", closed.data.destroyed === true)
    if (fake) step("the fake model answered", fake.requests > 0, `${fake.requests} request(s)`)

    if (SHOTS) writeFileSync(join(SHOTS, "transcript.txt"), transcript.join("\n"))

    console.log(`\n=== ${passed} OK, ${failed} failed ===`)
  } catch (error) {
    failed++
    console.error(`\n💥 ${error instanceof Error ? error.stack : error}`)
  } finally {
    mca?.kill()
    ui?.close()
    await server?.close().catch(() => {})
    for (const h of termHosts.all()) await termHosts.remove(h.appId).catch(() => {})
    await runDocker(["rm", "-f", termHosts.containerName(APP_ID), SOURCE]).catch(() => {})
    await fake?.close()
    process.exit(failed > 0 ? 1 : 0)
  }
}

main()
