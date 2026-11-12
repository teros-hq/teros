/**
 * Real terminal-host smoke (no backend, no Mongo): the PtyManager + TermHostManager
 * against real Docker and the real bash image.
 *
 *   IMAGE=teros/mca-runtime-bash:terminal-gem npx tsx scripts/smoke-terminal-host.mts
 *
 * 1. A stand-in "bash MCA container" (same image, a temp /app-data) is the clone source.
 * 2. A session is created in the terminal host; a command runs; read + screen.
 * 3. "Backend restart": a fresh PtyManager/TermHostManager adopts the running host;
 *    the session is there with its screen, scrollback and running process.
 * 4. Unicode, truecolor, alternate screen (vim-like) and bracketed paste survive the snapshot.
 * 5. Claude Code hooks helper: `teros-agent-state blocked` inside the pane → agent state.
 *
 * Exits 1 on the first broken expectation. Cleans its containers up.
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PtyManager } from "../packages/backend/src/services/pty-manager"
import { claudeHooksSetupScript } from "../packages/backend/src/services/terminal/agent-hooks"
import { runDocker, TermHostManager } from "../packages/backend/src/services/terminal/term-host"

const IMAGE = process.env.IMAGE ?? "teros/mca-runtime-bash:terminal-gem"
const STACK = `smoke-${process.pid}`
const APP = `app_smoke${String(process.pid).padStart(8, "0")}`
const WS = "work_smoke"
const SOURCE = `smoke-bash-src-${process.pid}`

let failures = 0
function check(ok: boolean, what: string, detail = ""): void {
  console.log(`${ok ? "✓" : "✗"} ${what}${detail ? `  (${detail})` : ""}`)
  if (!ok) failures++
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const pubSub = { broadcastToTopic: () => {} } as never

async function waitUntil(fn: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await sleep(100)
  }
  return false
}

const appData = mkdtempSync(join(tmpdir(), "teros-term-smoke-"))
const manager1 = new TermHostManager({ stackId: STACK })
try {
  const src = await runDocker([
    "run",
    "-d",
    "--name",
    SOURCE,
    "--memory",
    "512m",
    "--pids-limit",
    "256",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "NET_RAW",
    "-v",
    `${appData}:/app-data`,
    "--entrypoint",
    "sleep",
    IMAGE,
    "infinity",
  ])
  check(src.code === 0, "stand-in bash container started", src.stderr.trim())

  // ── 1+2: create a session ────────────────────────────────────────────────
  const pty1 = new PtyManager(pubSub)
  pty1.useTermHosts(manager1)
  const host = await manager1.ensure(APP, WS, async () => SOURCE)
  check(host.connected, "terminal host up, control client attached", host.container)
  const inspect = await runDocker([
    "inspect",
    "--format",
    "{{.HostConfig.Memory}} {{.HostConfig.PidsLimit}} {{json .HostConfig.SecurityOpt}} {{json .HostConfig.CapDrop}} {{.HostConfig.Init}}",
    host.container,
  ])
  check(
    /^536870912 256 \["no-new-privileges"\] \["(CAP_)?NET_RAW"\] true/.test(inspect.stdout.trim()),
    "host cloned the isolation settings",
    inspect.stdout.trim(),
  )

  await pty1.createInHost(host, "smoke-1", 100, 30, WS, {
    pinned: true,
    title: "smoke",
    kind: "shell",
    createdBy: "u1",
    appId: APP,
  })
  pty1.write(
    "smoke-1",
    'echo "héllo wörld ✓"; printf "\\e[38;2;10;200;30mTRUECOLOR\\e[0m\\n"; stty size\r',
  )
  const saw = await waitUntil(() => pty1.read("smoke-1").lines.some((l) => l.includes("30 100")))
  check(saw, "command ran at the window size (stty size = 30 100)")
  pty1.write("smoke-1", 'echo "P=$PATH"\r')
  const isPath = (l: string) => l.replace(/\r/g, "").startsWith("P=/")
  await waitUntil(() => pty1.read("smoke-1").lines.some(isPath))
  const pathLine = pty1.read("smoke-1").lines.find(isPath)?.replace(/\r/g, "") ?? ""
  check(
    pathLine.includes("/app-data/home/.local/bin") &&
      pathLine.includes("/app-data/.npm-global/bin"),
    "sessions keep the image PATH (npm -g, pip --user) plus ~/.local/bin",
    pathLine,
  )
  const screen1 = await pty1.screen("smoke-1")
  check(
    !!screen1?.lines.some((l) => l.includes("héllo wörld ✓")),
    "rendered screen has the unicode line",
    screen1?.lines.find((l) => l.includes("llo")),
  )
  const snap1 = await pty1.snapshot("smoke-1")
  check(!!snap1?.data.includes("\u001b[38;2;10;200;30m"), "snapshot keeps 24-bit colour")

  // A long-running process + alternate screen + bracketed paste, then "restart".
  pty1.write(
    "smoke-1",
    'clear; for i in $(seq 1 300); do echo "line $i"; done; printf "\\e[?2004h"; sleep 600\r',
  )
  await waitUntil(() => pty1.read("smoke-1").lines.some((l) => l.includes("line 300")))
  await sleep(300)

  // ── 3: backend restart ──────────────────────────────────────────────────
  host.disconnect()
  const manager2 = new TermHostManager({ stackId: STACK })
  const pty2 = new PtyManager(pubSub)
  pty2.useTermHosts(manager2)
  await pty2.adoptTermHosts()
  const info = pty2.describe("smoke-1")
  check(
    !!info && info.pinned && info.title === "smoke" && info.persistent,
    "adopted after restart with its policy and title",
    JSON.stringify(info && { pinned: info.pinned, title: info.title }),
  )
  check(
    info?.command === "sleep" || (await pty2.screen("smoke-1"))?.command === "sleep",
    "process still running after restart (foreground: sleep)",
  )
  const snap2 = await pty2.snapshot("smoke-1")
  check(
    !!snap2?.data.includes("line 300") && snap2.data.includes("line 1\u001b"),
    "snapshot after restart: screen + scrollback",
    `${snap2?.data.length} bytes`,
  )
  check(!!snap2?.data.includes("\u001b[?2004h"), "bracketed paste restored (tracked in @teros_bp)")
  check(
    pty2.read("smoke-1").lines.some((l) => l.includes("line 299")),
    "read buffer seeded from tmux history",
  )

  // Live output after restart reaches listeners.
  const got: string[] = []
  pty2.onOutput("smoke-1", (d) => got.push(d))
  pty2.write("smoke-1", "\u0003")
  pty2.write("smoke-1", "seq 1 2000 | less\r")
  await waitUntil(async () => (await pty2.screen("smoke-1"))?.alternateScreen === true, 5000)
  const alt = await pty2.screen("smoke-1")
  check(got.join("").length > 0, "live output flows after re-attach")
  const snapAlt = await pty2.snapshot("smoke-1")
  check(
    !!alt?.alternateScreen && !!snapAlt?.data.includes("\u001b[?1049h"),
    "alternate screen (less) restored in snapshot",
    `alt=${alt?.alternateScreen}`,
  )
  check(
    !!alt?.lines.some((l) => l.trim() === "1") && !!alt?.lines.some((l) => l.trim() === "20"),
    "rendered screen shows the full-screen app",
    alt?.lines[0],
  )
  pty2.write("smoke-1", "q")
  await sleep(500)

  // ── 5: agent-state hooks ────────────────────────────────────────────────
  const h2 = manager2.get(APP)!
  const setup = await h2.runScript(claudeHooksSetupScript())
  check(setup.code === 0, "claude hooks installed", setup.stderr.trim())
  const settings = await runDocker([
    "exec",
    h2.container,
    "cat",
    "/app-data/home/.claude/settings.json",
  ])
  check(
    settings.stdout.includes("/app-data/bin/teros-agent-state blocked"),
    "settings.json has the Notification hook",
  )
  pty2.write(
    "smoke-1",
    `echo '{"message":"Claude needs your permission to use Bash"}' | /app-data/bin/teros-agent-state blocked\r`,
  )
  const blocked = await waitUntil(
    () => pty2.describe("smoke-1")?.agentState?.state === "blocked",
    5000,
  )
  check(
    blocked,
    'agent state "blocked" reached the backend via tmux subscription',
    pty2.describe("smoke-1")?.agentState?.message,
  )
  if (!blocked)
    console.log((await pty2.screen("smoke-1"))?.lines.filter(Boolean).slice(-6).join("\n"))

  // ── Exit: destroying the window ends the session ───────────────────────
  pty2.destroy("smoke-1")
  check(!pty2.has("smoke-1"), "destroy removes the session")
  const left = await h2.listWindows()
  check(!left.some((w) => w.terminalId === "smoke-1"), "window gone from tmux")
  await manager2.remove(APP)
} catch (err) {
  console.error(err)
  failures++
} finally {
  await runDocker(["rm", "-f", SOURCE, manager1.containerName(APP)])
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed")
process.exit(failures ? 1 : 0)
