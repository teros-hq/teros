/**
 * Acceptance smoke: terminal sessions sleep instead of dying, and wake on use.
 *
 *   MONGODB_URI=mongodb://127.0.0.1:27026/?directConnection=true \
 *     IMAGE=teros/mca-runtime-bash:tgsleep npx tsx scripts/smoke-terminal-sleep.mts
 *
 * Real pieces: the MCA process and its tools, the WS bridge, the terminal
 * domain (its SessionWaker), PtyManager with a real terminal host (tmux in a
 * container cloned from the bash image), real `docker pause` / removal, the
 * Mongo sleep store, the real Claude Code TUI with its hooks on a local fake
 * Anthropic API. FREEZE_AFTER / HIBERNATE_AFTER are seconds here.
 *
 * Steps:
 *   1. a shell (cwd on the persistent volume, a marker printed), a Claude Code
 *      session (one turn: 6*7 → 42) and a "dev server" (sleep 99999), via tools
 *   2. nobody uses them → the host is frozen: docker says paused, the window
 *      gets 'frozen' events, terminal-list says so
 *   3. still nobody → hibernated: container removed, the sessions saved in
 *      Mongo (Claude Code's session id included), still listed as asleep
 *   4. terminal-screen on the shell wakes it: same terminalId, the old output
 *      above "— resumed after sleep —", terminal-run pwd → the same cwd
 *   5. terminal-prompt on Claude Code wakes it and resumes the conversation:
 *      the fake model receives the old prompt with the new one
 *   6. the window reopens the dev session (terminal.create, same id): woken,
 *      reported "sleep 99999 … not restarted"
 *   7. freeze again, then a second backend adopts the paused host: sessions
 *      listed, none lost (a paused container is not a dead one)
 * Exits 1 on any failed expectation. Removes its containers.
 * SMOKE_SCREENSHOTS=<dir>: panes (.ans) and the tool transcript; render with
 * scripts/smoke-terminal-shots.mts.
 */

import { spawn } from "node:child_process"
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
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
import { startFakeAnthropic } from "./smoke-terminal-fake-anthropic.mts"

const { createTestServer } = await import("@teros/testing")
const { McaHttpClient } = await import("../packages/backend/src/services/mca-http-client")
const { PtyManager } = await import("../packages/backend/src/services/pty-manager")
const { ProviderService } = await import("../packages/backend/src/services/provider-service")
const { runDocker, TermHostManager } = await import(
  "../packages/backend/src/services/terminal/term-host"
)
const { TerminalSleepStore } = await import("../packages/backend/src/services/terminal/sleep-store")

const IMAGE = process.env.IMAGE ?? "teros/mca-runtime-bash:tgsleep"
const FREEZE_MS = Number(process.env.SMOKE_FREEZE_MS) || 4000
const HIBERNATE_MS = Number(process.env.SMOKE_HIBERNATE_MS) || 6000
const APP_DATA =
  process.env.SMOKE_APP_DATA ?? join(homedir(), ".cache", "tgsleep-smoke", "app-data")
/** Claude Code installed by an earlier smoke: cloned (APFS) instead of downloaded again. */
const APP_DATA_SEED = join(homedir(), ".cache", "tgtools-smoke", "app-data")
const STACK = `tgsleep-${process.pid}`
const MCA_PORT = 13_900 + Math.floor(Math.random() * 800)
const MCA_URL = `http://127.0.0.1:${MCA_PORT}`
const MCA_ENTRY = join(ROOT, "mcas", "mca.teros.terminal", "src", "index.ts")

const OWNER_EMAIL = "owner@terminal-sleep-smoke.test"
const OWNER_ID = "user:test_owner"
const WORKSPACE_ID = "work_terminal_sleep_smoke"
const APP_ID = `app_tgsleep${String(process.pid).padStart(8, "0")}`
const SOURCE = `mca-teros-bash-${APP_ID.replace("app_", "").slice(-8)}`
const CWD = "/app-data/home/sleep-smoke"

let passed = 0
let failed = 0
function step(name: string, ok: boolean, detail = ""): void {
  if (ok) passed++
  else failed++
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`)
}

let mcaHttp: McaHttpClientType
const EXEC_CONTEXT = { userId: OWNER_ID, workspaceId: WORKSPACE_ID, appId: APP_ID } as const

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

/** Wait for a condition of the world (docker, events) — the lifecycle runs on its own clock. */
async function until(label: string, check: () => Promise<boolean> | boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  console.log(`   (gave up waiting for ${label} after ${timeoutMs} ms)`)
  return false
}

async function containerState(name: string): Promise<string> {
  const r = await runDocker(["inspect", "--format", "{{.State.Status}}", name])
  return r.code === 0 ? r.stdout.trim() : "gone"
}

async function main(): Promise<void> {
  console.log(
    `=== Smoke: terminal sessions sleep (freeze ${FREEZE_MS} ms, hibernate ${HIBERNATE_MS} ms) ===\n`,
  )
  const fake = await startFakeAnthropic()
  if (!existsSync(join(APP_DATA, "home", ".local")) && existsSync(APP_DATA_SEED)) {
    mkdirSync(join(APP_DATA, ".."), { recursive: true })
    cpSync(APP_DATA_SEED, APP_DATA, { recursive: true })
  }
  mkdirSync(join(APP_DATA, "home", "sleep-smoke"), { recursive: true })
  rmSync(join(APP_DATA, "home", ".claude"), { recursive: true, force: true })
  rmSync(join(APP_DATA, "home", ".claude.json"), { force: true })
  if (SHOTS) mkdirSync(SHOTS, { recursive: true })

  const termHosts = new TermHostManager({ stackId: STACK })
  const hostName = termHosts.containerName(APP_ID)
  let server: TestServerInstance | undefined
  let ui: TestWebSocketClient | undefined
  let mca: ReturnType<typeof spawn> | undefined
  try {
    const src = await runDocker([
      "run",
      "-d",
      "--name",
      SOURCE,
      "-v",
      `${APP_DATA}:/app-data`,
      "-e",
      `ANTHROPIC_BASE_URL=http://host.docker.internal:${fake.port}`,
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

    const ptyManager = new PtyManager(
      {
        broadcastToTopic(topic: string, event: Record<string, unknown>) {
          server?.pubSubService?.broadcastToTopic(topic, event)
        },
      } as any,
      { freezeAfterMs: FREEZE_MS, hibernateAfterMs: HIBERNATE_MS },
    )
    ptyManager.useTermHosts(termHosts)
    paneOf = (id) => ptyManager.paneOf(id)
    const mcaManager = {
      executeTool: async () => ({ output: "", isError: false }),
    } as unknown as McaManager
    const key = `sk-ant-api03-${"fake".repeat(16)}`

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
      name: "Sleep smoke",
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

    // ── The user's Terminal window: the session list, live
    ui = await server.createClient()
    await ui.authenticate(OWNER_EMAIL)
    const events: any[] = []
    ui.getRawSocket().on("message", (raw: Buffer) => {
      const m = JSON.parse(raw.toString())
      if (m.type === "terminal_sessions") events.push(m)
    })
    await wsAction(ui, "terminal.watch", { workspaceId: WORKSPACE_ID })
    const saw = (id: string, reason: string) =>
      events.some((e) => e.terminalId === id && e.reason === reason)

    // ── The MCA process
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
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${MCA_URL}/health`)).ok) break
      } catch {}
      await new Promise((r) => setTimeout(r, 200))
    }

    // ── 1. Three sessions
    const shell = await tool("terminal-create", { title: "Smoke: shell", cwd: CWD })
    show("terminal-create (shell)", shell.text)
    const shellId = shell.data.terminalId as string
    const marker = await tool("terminal-run", {
      terminalId: shellId,
      command: "echo MARKER_BEFORE_SLEEP_$((40+2))",
    })
    step("shell: marker printed", /MARKER_BEFORE_SLEEP_42/.test(marker.data.output ?? ""))

    const claude = await tool("terminal-create", {
      agent: "claude",
      title: "Smoke: Claude Code",
      cwd: CWD,
    })
    show("terminal-create agent=claude", claude.text)
    const claudeId = claude.data.terminalId as string
    let ready = claude.data
    if (ready.status === "starting") {
      ready = (
        await tool("terminal-wait", { terminalId: claudeId, until: "ready", timeoutMs: 100_000 })
      ).data
    }
    step("Claude Code ready", ready.reason === "ready", `reason=${ready.reason}`)
    let first = await tool("terminal-prompt", {
      terminalId: claudeId,
      text: "What is 6*7? Answer with just the number.",
    })
    if (first.data.reason === "blocked") {
      // Claude Code's one-time offer (auto mode): keep manual mode, send the prompt.
      await tool("terminal-send-key", { terminalId: claudeId, keys: ["down", "enter", "enter"] })
      first = await tool("terminal-wait", {
        terminalId: claudeId,
        until: "turn",
        timeoutMs: 60_000,
      })
    }
    show("terminal-prompt 6*7", first.text)
    step("Claude Code answered (42 on screen)", /\b42\b/.test(first.data.screen ?? ""))
    await capture("1-claude-before-sleep", claudeId)
    await capture("1-shell-before-sleep", shellId)

    const dev = await tool("terminal-create", { title: "Smoke: dev server", cwd: CWD })
    const devId = dev.data.terminalId as string
    await tool("terminal-write", { terminalId: devId, text: "sleep 99999" })

    // ── 2. Frozen
    const t0 = Date.now()
    const frozen = await until(
      "the host to be paused",
      async () => (await containerState(hostName)) === "paused",
      FREEZE_MS * 6 + 10_000,
    )
    step(
      "idle host frozen: docker pause",
      frozen,
      `${((Date.now() - t0) / 1000).toFixed(1)} s after the last tool call (FREEZE_AFTER ${FREEZE_MS / 1000} s)`,
    )
    const ps = await runDocker([
      "ps",
      "--filter",
      `name=${hostName}`,
      "--format",
      "{{.Names}} {{.Status}}",
    ])
    show("docker ps (frozen)", ps.stdout.trim())
    step(
      "window: 'frozen' event for each session",
      [shellId, claudeId, devId].every((id) => saw(id, "frozen")),
    )
    const listFrozen = await tool("terminal-list")
    show("terminal-list (frozen)", listFrozen.text)
    step(
      "terminal-list: frozen, and listing did not wake it",
      /frozen \(idle; wakes when used\)/.test(listFrozen.text) &&
        (await containerState(hostName)) === "paused",
    )

    // ── 3. Hibernated
    const t1 = Date.now()
    const gone = await until(
      "the host to be removed",
      async () => (await containerState(hostName)) === "gone",
      HIBERNATE_MS * 4 + 20_000,
    )
    step(
      "frozen host hibernated: container removed",
      gone,
      `${((Date.now() - t1) / 1000).toFixed(1)} s frozen`,
    )
    const saved = await db
      .collection("terminal_sleeping_sessions")
      .find({ stackId: STACK })
      .toArray()
    step("three sessions saved to Mongo", saved.length === 3, `${saved.length}`)
    const savedClaude: any = saved.find((d: any) => d.terminalId === claudeId)
    step(
      "Claude Code's session id was recorded by its hooks",
      /^[A-Za-z0-9-]{8,}$/.test(savedClaude?.agentSession ?? ""),
      savedClaude?.agentSession ?? "(none)",
    )
    const savedDev: any = saved.find((d: any) => d.terminalId === devId)
    step(
      "what ran in the dev session was recorded",
      savedDev?.foreground === "sleep 99999",
      savedDev?.foreground,
    )
    step(
      "window: 'sleep' events, no 'exit'",
      [shellId, claudeId, devId].every((id) => saw(id, "sleep") && !saw(id, "exit")),
    )
    const listAsleep = await tool("terminal-list")
    show("terminal-list (asleep)", listAsleep.text)
    step(
      "terminal-list: all three still listed, asleep",
      (listAsleep.text.match(/asleep for/g) ?? []).length === 3,
    )

    // ── 4. The shell wakes on a look
    const t2 = Date.now()
    const look = await tool("terminal-screen", { terminalId: shellId })
    const wakeShellMs = Date.now() - t2
    show("terminal-screen (wakes the shell)", look.text)
    step(
      "tool says it woke the session",
      look.data.woke === "sleeping" && /was asleep/.test(look.text),
      `${wakeShellMs} ms`,
    )
    step(
      "old output above the resumed-after-sleep line",
      /MARKER_BEFORE_SLEEP_42/.test(look.text) && /— resumed after sleep —/.test(look.text),
    )
    const pwd = await tool("terminal-run", { terminalId: shellId, command: "pwd" })
    step("same cwd", (pwd.data.output ?? "").trim() === CWD, (pwd.data.output ?? "").trim())
    step("same terminalId, event 'wake'", saw(shellId, "wake"))
    await capture("2-shell-after-wake", shellId)

    // ── 5. Claude Code wakes on a prompt and resumes its conversation
    const t3 = Date.now()
    const second = await tool("terminal-prompt", {
      terminalId: claudeId,
      text: "And what is 7*8? Answer with just the number.",
    })
    show("terminal-prompt 7*8 (wakes Claude Code)", second.text)
    step(
      "Claude Code woken by the prompt",
      second.data.woke === "sleeping",
      `${Date.now() - t3} ms incl. the turn`,
    )
    step(
      "turn done, 56 on screen",
      second.data.reason === "done" && /\b56\b/.test(second.data.screen ?? ""),
      `reason=${second.data.reason}`,
    )
    step(
      "the conversation was resumed (the model got the old prompt)",
      fake.conversation.some((t) => t.includes("6*7")) &&
        fake.conversation.some((t) => t.includes("7*8")),
      `${fake.conversation.length} prompt(s) in the request`,
    )
    await capture("3-claude-after-wake", claudeId)

    // ── 6. The window reopens the dev session
    const reopened = await wsAction(
      ui,
      "terminal.create",
      { terminalId: devId, appId: APP_ID, subscribe: false },
      120_000,
    )
    step(
      "window reopen (terminal.create, same id) woke it",
      reopened.woke === "sleeping" && reopened.reused === true,
    )
    const devInfo = (
      await wsAction(ui, "terminal.list", { workspaceId: WORKSPACE_ID })
    ).sessions.find((s: any) => s.terminalId === devId)
    show("dev session after wake", JSON.stringify(devInfo?.resumed, null, 2))
    step(
      "the dev server is reported as not restarted",
      devInfo?.resumed?.notRestored === "sleep 99999" && devInfo?.lifecycle === "awake",
    )
    await capture("4-dev-after-wake", devId)
    step(
      "nothing left in the sleep store",
      (await db.collection("terminal_sleeping_sessions").countDocuments({ stackId: STACK })) === 0,
    )
    console.log(`\n   lifecycle stats: ${JSON.stringify(ptyManager.lifecycleStats())}`)

    // ── 7. A backend restart while frozen
    const refrozen = await until(
      "the host to freeze again",
      async () => (await containerState(hostName)) === "paused",
      FREEZE_MS * 6 + 10_000,
    )
    step("frozen again", refrozen)
    const second_ = new PtyManager({ broadcastToTopic() {} } as any, { freezeAfterMs: 3600_000 })
    const hosts2 = new TermHostManager({ stackId: STACK })
    second_.useTermHosts(hosts2)
    second_.useSleepStore(new TerminalSleepStore(db))
    await second_.adoptTermHosts()
    const adopted = second_.list().map((s) => s.terminalId)
    step(
      "a new backend adopts the paused host: every session listed, none lost",
      [shellId, claudeId, devId].every((id) => adopted.includes(id)),
      `${adopted.length} session(s)`,
    )
    for (const h of hosts2.all()) h.disconnect()

    if (SHOTS) writeFileSync(join(SHOTS, "transcript.txt"), transcript.join("\n"))
    console.log(`\n=== ${passed} OK, ${failed} failed ===`)
  } catch (error) {
    failed++
    console.error(`\n💥 ${error instanceof Error ? error.stack : error}`)
  } finally {
    mca?.kill()
    ui?.close()
    await server?.db
      ?.collection("terminal_sleeping_sessions")
      .deleteMany({ stackId: STACK })
      .catch(() => {})
    await server?.close().catch(() => {})
    await runDocker(["unpause", hostName]).catch(() => {})
    await runDocker(["rm", "-f", hostName, SOURCE]).catch(() => {})
    await fake.close()
    process.exit(failed > 0 ? 1 : 0)
  }
}

main()
