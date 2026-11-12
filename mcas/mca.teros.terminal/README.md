# mca.teros.terminal

Terminal sessions a Teros agent drives while the user watches. The typical
scene: the user chats with their agent and keeps the **Terminal window** open
beside the chat; the agent opens Claude Code there, with the user's own
sign-in, gives it a task and reports back, and the user sees every keystroke
(and can type into the same session at any time — the window shows who is
typing). (Host shells were removed with `mca.teros.admin.bash` on 2026-10-19 —
terminal sessions run in the workspace terminal host; see the terminal domain
header.)

Sessions live in the workspace's **terminal host**: a `teros-term-*` container
(a clone of the Bash app's container: same image, files, home, networks and
limits) running a tmux server; each session is a tmux window. They survive
backend restarts and browser tabs. See
`packages/backend/src/services/terminal/term-host.ts`.

## Sessions sleep, they don't expire

A session ends only when someone closes it (`terminal-destroy`, the window's
×) or its shell exits. Idle sessions sleep instead (`pty-manager.ts`):

| State | When | What it costs | Coming back |
|---|---|---|---|
| `awake` | in use | the machine runs | — |
| `frozen` | every session of the workspace's machine idle 15 min (no input, no output, no viewer, no wait) — `TERMINAL_FREEZE_AFTER_MS` | `docker pause`: no CPU, memory kept | unpause, < 1 s, nothing lost |
| `sleeping` | frozen for 2 h — `TERMINAL_HIBERNATE_AFTER_MS` | each session saved (last 5k lines, cwd, title, what ran, Claude Code's session id) in `terminal_sleeping_sessions`; the machine is removed | a new machine, same `terminalId` and cwd, the old output printed dimmed above a `— resumed after sleep —` line, Claude Code resumed with `claude --resume <id>` (`--continue` when no id), Codex/opencode started again; anything else that was running (a dev server) is reported as not restarted |

A coding agent mid-turn prints (its spinner), so it never counts as idle.
Every tool that uses a session wakes it first and starts its answer with what
happened ("The session was asleep; it was woken first…"); after a wake from
sleep the tools wait until Claude Code is ready again before typing.
`terminal-list` shows `frozen` / `asleep for 3 h`; listing never wakes
anything. The old `pinned` option is accepted and ignored.

## How an agent drives Claude Code

```
terminal-create  agent="claude" title="Fix the login bug"
  → "Opened session term_… with Claude Code. … Claude Code is ready for a prompt."  + screen
terminal-prompt  terminalId text="Find why /login 500s and fix it.\nRun the tests."
  → "Claude Code finished its turn (after 48.2 s). Its answer is on the screen below." + screen
  → or "Claude Code is waiting for an answer: "Claude needs your permission to use Bash" …"
terminal-send-key keys=["1"]          (answer the permission menu the screen shows)
terminal-wait    until="turn"         (instead of sleeping; repeat while it is still working)
terminal-prompt  text="/exit"         → "Claude Code is not running any more (back at the shell)."
```

- Every answer is plain text for the model: what happened, the rendered screen
  (as the user sees it — never escape codes) and the next step. The same data
  comes as `structuredContent` for scripts.
- Waits never sleep or poll from the agent's side: `terminal-wait` (and the
  waits inside `terminal-create` / `terminal-prompt` / `terminal-run`) use the
  coding agent's own hooks (Claude Code's `Stop`, `Notification`… →
  `teros-agent-state` → tmux pane option, ≤1 s) or the screen heuristic for
  agents without hooks, the pane's foreground command and output timing. Only
  what happens after the agent's last write counts, so the previous turn's
  `done` never ends a new wait. A wait that runs out is not an error: it says
  what is going on ("still working") and can be called again. Each tool call
  answers within 100 s (the backend gives an MCA call 120 s).
- `terminal-prompt` types the prompt (a multi-line one as one bracketed paste —
  Claude Code would submit the first line otherwise), lets it land, checks the
  screen for a question, and only then presses Enter: an Enter sent blindly
  would answer a dialog the agent just opened. "Done" / "ready" are reported
  on a settled screen, and a menu or question on screen turns them into
  `blocked` with the question and the highlighted option (Claude Code's
  dialogs fire no hook). If the agent never starts working (~8 s, quiet
  screen), the answer is `not-started` instead of a long wait. An agent's key
  presses start its next wait, so the previous `blocked` is not reported again.
- `terminal-run` waits for the shell prompt to be back on the last screen row
  (a pure-bash loop keeps bash in the foreground and is not "finished").
- Claude Code's first-run screens (theme, security notes) are skipped for every
  session; the folder trust check only for sessions a Teros agent opens. The
  credentials are the user's own (Sign in with Claude / API key / Use Teros),
  injected only if they shared them with the workspace's agents; without them
  the tools answer "needs to sign in — ask the user", never ask for a secret.
- `show` (default true) asks the user's Terminal window to bring the session up
  (`terminal_sessions` event with reason `reveal`); `terminal-show` does it for
  an existing session. Every agent write is announced (reason `input`,
  `lastInput`), so the window can follow the session the agent is driving.

## The wheel (who drives)

A session has one driver: the agent, a person or nobody (`driver` on every
session; `watchers` lists the people with it open and the agents waiting on
it). The agent's write takes the wheel only when nobody holds it, an agent
does, or the person at it has been idle for over 60 s; otherwise the write is
refused (`WHEEL_HELD`: "<name> has the wheel; wait or ask them in chat").
When a person takes the wheel (`terminal.takeWheel`, or simply typing), an
agent's `terminal-wait` returns early (reason `driver`). When they give it back
(`terminal.giveBack`, optional note), the agent's next wait / read / screen
leads with "<name> gave you the wheel back. Their note: …" — once. Every tool
call carries the calling agent's id (`agentId`, checked against the app's
grants), so the seat shows that agent's name and avatar.

## Tools

| Tool | Backend action | Purpose |
|---|---|---|
| `-health-check` | — | Reports bridge WS status to the backend |
| `terminal-create` | `terminal.create` (+ `terminal.wait` ready) | Open a shell, or Claude Code / Codex / opencode (`agent`), shown in the user's window; waits until the agent is ready |
| `terminal-prompt` | `terminal.write` (paste) + `terminal.wait` turn | Give a coding agent a task and wait for its turn to end (done / blocked / needs-login / exited) |
| `terminal-wait` | `terminal.wait` | Wait for a state: `turn`, `ready`, `exit`, `quiet`, `text` — returns the screen |
| `terminal-run` | `terminal.write` + `terminal.wait` exit + `terminal.read` | Run a shell command, get its output |
| `terminal-screen` | `terminal.screen` + `terminal.status` | The screen as text with the agent state; `onlyChanges` for just the changed rows |
| `terminal-read` | `terminal.read` | Output log (tail or `since` cursor), carriage returns rendered |
| `terminal-write` | `terminal.write` | Low level: type text (+ Enter), pasted when multi-line |
| `terminal-send-key` | `terminal.input` | Keys and key sequences: enter, arrows, shift-tab, ctrl-<x>, alt-<x>, F-keys… |
| `terminal-wait-for` | `terminal.waitFor` | Regex on the output log (kept for compatibility) |
| `terminal-list` | `terminal.list` | Sessions (title, command, agent state, opener, watchers, frozen / asleep — never wakes) |
| `terminal-show` | `terminal.reveal` | Bring a session up in the user's Terminal window |
| `terminal-destroy` | `terminal.destroy` | Close a session (idempotent) |

## Architecture

```
agent ──HTTP /tools/call──▶ MCA process ──WS /mca (admin_request)──▶ backend terminal.* domain
                                                                          │
user Terminal window ◀──/ws/terminal (binary frames, snapshots)──────────┤  PtyManager
                                                                          │  one tmux control client
                                                                          ▼  per workspace (docker exec)
                                                   teros-term-<app> container: tmux server
                                                   (1 window = 1 session; screen, history, agent state)
```

- `terminal-screen` reads tmux's own grid (`capture-pane`): the screen as it is
  drawn, not the ANSI-stripped stream. Use it to drive TUIs; use
  `terminal-read`/`terminal-wait-for` for line-oriented commands.
- Agent writes wait (up to 5 s) while a person is typing in the same session,
  so keystrokes never interleave on one command line.

- The MCA process connects to the backend over WebSocket (`MCA_WS_URL`) and its
  tools translate to `terminal.*` WS actions. Authz is workspace-sovereign: the
  PTY belongs to the workspace owning the app, and every action re-checks
  membership (`FORBIDDEN_TERMINAL` otherwise).
- The UI terminal window subscribes to `terminal:{terminalId}` and receives
  `terminal_output` / `terminal_exit` broadcasts. `terminal.input` (keystrokes)
  and `terminal.read`/`terminal.status` operate on the same shared buffer.
- Sessions never expire: idle ones freeze and sleep (see above) and wake on use.

## Prompt semantics (waitFor)

Interactive prompts (`>>> `, `user@host:~$ `) **never end in a newline**, so
they never become complete buffer lines. `terminal-wait-for` matches them via
the pending partial line (virtual last line of the buffer). Patterns like
`"\\$ $"` or `">>>"` from the tool docs work against real shells.

## Testing

- **Agent acceptance smoke** (`scripts/smoke-terminal-agent.mts`, node/tsx,
  Docker): the real MCA process, bridge, terminal domain and a real terminal
  host drive the **real Claude Code TUI** through the tools only — create
  `agent=claude` → ready, a two-line `terminal-prompt` → `done` with the answer
  on screen, `/exit`, `terminal-run`, list, destroy; no sleeps, no retries. The
  model behind Claude Code is a local fake Anthropic API
  (`scripts/smoke-terminal-fake-anthropic.mts`; `SMOKE_REAL_ANTHROPIC=1` +
  `ANTHROPIC_API_KEY` for the real one).
  `MONGODB_URI=mongodb://127.0.0.1:<throwaway>/?directConnection=true npx tsx scripts/smoke-terminal-agent.mts`
- Unit: `packages/backend/tests/unit/terminal-agent-wait.test.ts` (waits,
  announcements), `terminal-handlers.test.ts`, `mcas/mca.teros.terminal/test/lib.test.ts`
  (keys, screen text, command output).

- **Integration suite** (`packages/backend/tests/integration/terminal-mca.test.ts`,
  runs under bun): spawns the real MCA process against the TestServer bridge with
  scripted PTYs — full tool flow, UI convivencia, shared buffer, no auto-destroy, authz.
- **Sleep smoke** (`scripts/smoke-terminal-sleep.mts`, node/tsx, Docker): a
  shell and a Claude Code session freeze (docker pause), hibernate (container
  removed) and wake through the tools: same cwd, old output shown, Claude Code
  back on its conversation; also a backend restart while frozen.
- Unit: `packages/backend/tests/unit/terminal-sleep.test.ts` (lifecycle with a
  fake clock, wake in place, boot reload, resume command).
- **Real-PTY smoke** (`scripts/smoke-terminal-mca.mts`, runs under node/tsx):
  obsolete since 2026-10-19 — it exercised the host-PTY path removed with
  `mca.teros.admin.bash`. Kept for reference; rewrite for container mode pending.

> **Why two?** bun + node-pty is unstable: host PTYs die at ~15–20 ms (fd
> lifecycle bug under bun; works fine under node). The suite masks this with
> scripted PTYs; the smoke validates the real thing under node.

## Known limitations

- `terminal-run` gives no exit code (only the output), and a command whose
  shell prompt doesn't end in one of `$ # % > ❯ ➜ λ »` is reported finished
  only after 15 s of quiet. `read -p "Name: "` waiting for input is reported
  as still running (correct) until that 15 s fallback.
- Claude Code's "Make auto mode your default permission mode?" offer appears
  on the first submit in manual mode and takes that Enter; the tools report
  `blocked` / `not-started` with the screen, the agent answers and resends.

- Processes don't survive a restart of the terminal-host container itself
  (Docker daemon restart, OOM): sessions end and the window drops them. Backend
  restarts, tab closes and idleness (sessions sleep) are survived.
- Waking from sleep restarts the shell: shell variables, background jobs and
  a running program (dev server, vim) are gone — the tools say what was not
  restarted. Claude Code's conversation comes back (its transcript lives in
  `~/.claude` on the persistent volume).
- A silent long job (a build with no output for 15 min, nobody watching) is
  frozen with its machine; it continues where it was when the session wakes.

- `terminal-destroy` on an already-dead session is a silent no-op: the backend
  always answers `ok: true`, so the tool's `alreadyGone` branch is unreachable
  (see `@todo nira - 2026-10-10` in `src/index.ts`).
- `waitFor` matches line-by-line: a pattern spanning a line break needs two
  waits (or `terminal-read` + local regex).
