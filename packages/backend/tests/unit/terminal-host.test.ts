/**
 * Terminal host building blocks: the tmux control-mode parser (fixtures are
 * real tmux 3.3a transcripts from the bash image), snapshot assembly and the
 * clone of the bash container's isolation settings.
 */

import { describe, expect, it } from "bun:test"
import { formatAgentState, parseAgentState } from "../../src/services/pty-manager"
import { detectBlocked, nextHeuristicState } from "../../src/services/terminal/agent-heuristics"
import type { ExecStream } from "../../src/services/terminal/exec-stream"
import {
  bracketedPasteChange,
  buildSnapshot,
  PANE_MODES_FORMAT,
  parsePaneModes,
  renderedScreen,
} from "../../src/services/terminal/snapshot"
import { cloneRunArgs, dockerFailure, TermHost } from "../../src/services/terminal/term-host"
import {
  TmuxControlClient,
  tmuxQuote,
  unescapeOutput,
} from "../../src/services/terminal/tmux-control"

function fakeStream() {
  let onData: (chunk: Buffer) => void = () => {}
  let onExit: (code: number | null, stderr: string) => void = () => {}
  const written: string[] = []
  const stream: ExecStream = {
    write: (d) => {
      written.push(String(d))
      return true
    },
    onData: (l) => {
      onData = l
    },
    onExit: (l) => {
      onExit = l
    },
    drained: async () => {},
    close: () => {},
    pid: 1,
  }
  return {
    stream,
    written,
    feed: (text: string | Buffer) =>
      onData(typeof text === "string" ? Buffer.from(text, "latin1") : text),
    exit: (code: number) => onExit(code, ""),
  }
}

describe("tmux control mode — parser", () => {
  it("unescapes \\ooo octal at byte level and passes raw UTF-8 through", () => {
    // Real line: `%output %1 h\303\251llo` is what tmux sends for an escaped
    // byte pair, while raw é (C3 A9) arrives unescaped.
    const line = Buffer.concat([
      Buffer.from("x \\033[31mred\\134 "),
      Buffer.from("é", "utf8"),
      Buffer.from("\\015\\012"),
    ])
    expect(unescapeOutput(line, 2).toString("utf8")).toBe("\u001b[31mred\\ é\r\n")
  })

  it("skips the attach block (flags 0), resolves our commands in order, emits output per pane", async () => {
    const { stream, feed, written } = fakeStream()
    const client = new TmuxControlClient(stream)
    const outputs: Array<[string, string]> = []
    client.on({ output: (pane, data) => outputs.push([pane, data.toString("utf8")]) })
    feed("%begin 1792405534 264 0\n%end 1792405534 264 0\n%session-changed $0 teros\n")
    const p1 = client.command("new-window -d -P -F '#{window_id} #{pane_id}'")
    const p2 = client.command("display -p hi")
    expect(written).toEqual(["new-window -d -P -F '#{window_id} #{pane_id}'\n", "display -p hi\n"])
    // Output between replies, split across chunks mid-line and mid-character.
    const utf = Buffer.from("%output %1 héllo\\015\\012\n", "utf8")
    feed("%begin 1792405534 269 1\n@1 %1\n%end 1792405534 269 1\n")
    feed(utf.subarray(0, 13))
    feed(utf.subarray(13))
    feed("%begin 1792405534 270 1\nhi\n%end 1792405534 270 1\n")
    expect(await p1).toEqual(["@1 %1"])
    expect(await p2).toEqual(["hi"])
    expect(outputs).toEqual([["%1", "héllo\r\n"]])
  })

  it('%extended-output (pause-after on) carries the payload after " : "', () => {
    const { stream, feed } = fakeStream()
    const client = new TmuxControlClient(stream)
    const outputs: string[] = []
    client.on({ output: (pane, data) => outputs.push(`${pane}=${data.toString()}`) })
    feed('%extended-output %1 0 : a;b $HOME "x"\\015\\012\n')
    expect(outputs).toEqual(['%1=a;b $HOME "x"\r\n'])
  })

  it("a command block whose content starts with %end is not mistaken for the end", async () => {
    const { stream, feed } = fakeStream()
    const client = new TmuxControlClient(stream)
    const p = client.command("capture-pane -p")
    feed("%begin 1 7 1\n%end of the line\n%end 1 7 1\n")
    expect(await p).toEqual(["%end of the line"])
  })

  it("%error rejects with the message; exit rejects everything pending", async () => {
    const { stream, feed, exit } = fakeStream()
    const client = new TmuxControlClient(stream)
    const bad = client.command("kill-window -t @99")
    feed("%begin 1 8 1\ncan't find window: @99\n%error 1 8 1\n")
    await expect(bad).rejects.toThrow("can't find window")
    const pending = client.command("list-windows")
    let reason = ""
    client.on({ exit: (r) => (reason = r) })
    exit(1)
    await expect(pending).rejects.toThrow("control client ended")
    expect(client.alive).toBe(false)
    expect(reason).toContain("exited")
  })

  it("window close, pause and subscription notifications", () => {
    const { stream, feed } = fakeStream()
    const client = new TmuxControlClient(stream)
    const events: string[] = []
    client.on({
      windowClose: (w) => events.push(`close ${w}`),
      pause: (p) => events.push(`pause ${p}`),
      subscription: (c) => events.push(`${c.name} ${c.paneId} ${c.windowId} = ${c.value}`),
    })
    feed("%unlinked-window-close @2\n%window-close @3\n%pause %4\n")
    feed(
      "%subscription-changed agent $0 @1 1 %1 : blocked|1792406000|Claude needs your permission\n",
    )
    expect(events).toEqual([
      "close @2",
      "close @3",
      "pause %4",
      "agent %1 @1 = blocked|1792406000|Claude needs your permission",
    ])
  })

  it("sendInput: printable runs as -l (quoted), control bytes as -H hex, in order", async () => {
    const { stream, feed, written } = fakeStream()
    const client = new TmuxControlClient(stream)
    const done = client.sendInput("%1", "echo 'hé'\r\u001b[A")
    expect(written).toEqual([
      // `--` ends option parsing: tmux 3.3a reads a literal starting with '-' as a flag (f8a5277f6)
      `send-keys -t %1 -l -- ${tmuxQuote("echo 'hé'")}\n`,
      "send-keys -t %1 -H 0d 1b\n",
      `send-keys -t %1 -l -- '[A'\n`,
    ])
    feed("%begin 1 1 1\n%end 1 1 1\n%begin 1 2 1\n%end 1 2 1\n%begin 1 3 1\n%end 1 3 1\n")
    await done
  })

  it("onReply runs synchronously at the reply, before later notifications of the same chunk", async () => {
    const { stream, feed } = fakeStream()
    const client = new TmuxControlClient(stream)
    const order: string[] = []
    client.on({ output: () => order.push("output") })
    const p = client.command("capture-pane -p", () => order.push("reply"))
    feed("%output %1 before\n%begin 1 1 1\nscreen\n%end 1 1 1\n%output %1 after\n")
    await p
    expect(order).toEqual(["output", "reply", "output"])
  })

  it("tmuxQuote survives quotes, $ and ;", () => {
    expect(tmuxQuote("it's $HOME; x")).toBe(`'it'\\''s $HOME; x'`)
  })
})

describe("snapshots", () => {
  const modes = (over: Partial<Record<string, string>> = {}) => {
    const fields: Record<string, string> = {
      w: "80",
      h: "3",
      alt: "0",
      cx: "5",
      cy: "2",
      cur: "1",
      kpc: "0",
      kp: "0",
      ms: "0",
      mb: "0",
      ma: "0",
      sgr: "0",
      mu: "0",
      ins: "0",
      su: "0",
      sl: "2",
      hist: "2",
      bp: "1",
      cmd: "bash",
      title: "host: ~",
      ...over,
    }
    return parsePaneModes(Object.values(fields).join("\u001f"))
  }

  it("the format string has one field per parsed mode", () => {
    expect(PANE_MODES_FORMAT.split("\u001f")).toHaveLength(20)
  })

  it("normal screen: history + screen, cursor, bracketed paste, title", () => {
    const data = buildSnapshot({
      modes: modes(),
      history: ["h1", "h2"],
      screen: ["s1", "s2", "$ "],
    })
    expect(data).toBe(
      "h1\u001b[0m\r\nh2\u001b[0m\r\ns1\u001b[0m\r\ns2\u001b[0m\r\n$ \u001b[0m\u001b[3;6H\u001b[?2004h\u001b]2;host: ~\u0007",
    )
  })

  it("alternate screen: main history + saved main screen, then ?1049h and the app screen; modes restored", () => {
    const data = buildSnapshot({
      modes: modes({ alt: "1", cur: "0", ma: "1", sgr: "1", kpc: "1", bp: "0", title: "" }),
      history: ["h1"],
      savedMain: ["m1", "m2", "m3"],
      screen: ["vim1", "vim2", "vim3"],
    })
    expect(
      data.startsWith(
        "h1\u001b[0m\r\nm1\u001b[0m\r\nm2\u001b[0m\r\nm3\u001b[0m\u001b[?1049h\u001b[Hvim1",
      ),
    ).toBe(true)
    expect(data).toContain("\u001b[?25l")
    expect(data).toContain("\u001b[?1003h")
    expect(data).toContain("\u001b[?1006h")
    expect(data).toContain("\u001b[?1h")
    expect(data).not.toContain("\u001b[?2004h")
  })

  it("scroll region is restored before the cursor (DECSTBM homes it)", () => {
    const data = buildSnapshot({
      modes: modes({ h: "10", su: "1", sl: "8", cy: "4" }),
      history: [],
      screen: [],
    })
    expect(data.indexOf("\u001b[2;9r")).toBeLessThan(data.indexOf("\u001b[5;6H"))
  })

  it("a title cannot smuggle escape sequences", () => {
    const data = buildSnapshot({
      modes: modes({ title: "x\u0007\u001b]52;c;ZXZpbA==" }),
      history: [],
      screen: [],
    })
    expect(data.endsWith("\u001b]2;x]52;c;ZXZpbA==\u0007")).toBe(true)
  })

  it("rendered screen trims trailing spaces but keeps row indices", () => {
    const r = renderedScreen(modes(), ["a   ", "", "b"])
    expect(r.lines).toEqual(["a", "", "b"])
    expect(r.cursor).toEqual({ x: 5, y: 2, visible: true })
    expect(r.command).toBe("bash")
  })

  it("bracketed paste tracking: last toggle wins, no-op when unchanged", () => {
    expect(bracketedPasteChange("\u001b[?2004h$ ", false)).toBe(true)
    expect(bracketedPasteChange("\u001b[?2004h", true)).toBeNull()
    expect(bracketedPasteChange("\u001b[?2004h ls \u001b[?2004l", true)).toBe(false)
    expect(bracketedPasteChange("plain", true)).toBeNull()
  })
})

describe("agent state option", () => {
  it("round-trips state|time|message, rejects unknown states", () => {
    const s = parseAgentState("blocked|1792406000|Claude needs your permission to use Bash")
    expect(s).toMatchObject({
      state: "blocked",
      message: "Claude needs your permission to use Bash",
      source: "hook",
    })
    expect(s?.at.getTime()).toBe(1792406000 * 1000)
    expect(parseAgentState(formatAgentState(s!))).toEqual(s)
    expect(parseAgentState("ended|1|")).toBeNull()
    expect(parseAgentState("")).toBeNull()
  })
})

describe("docker failures are never empty", () => {
  it("says stderr, else stdout, else the exit code (and the timeout when the call was killed)", () => {
    expect(dockerFailure({ code: 1, stdout: "", stderr: " No such container: x \n" })).toBe("No such container: x")
    expect(dockerFailure({ code: 1, stdout: "conflict\n", stderr: "" })).toBe("conflict")
    expect(dockerFailure({ code: 137, stdout: "", stderr: "" })).toBe("docker exited with code 137")
    expect(dockerFailure({ code: 1, stdout: "", stderr: "", timedOutMs: 15_000 })).toBe(
      "docker did not answer within 15 s (exit code 1)",
    )
  })
})

describe("window options", () => {
  function hostWithFakeControl() {
    const commands: string[] = []
    const host = new TermHost("c", "app_1", "work_1", (() => null) as any, (async () => ({ code: 0, stdout: "", stderr: "" })) as any, 1000)
    host.ensureControl = async () => ({ command: async (c: string) => (commands.push(c), []) }) as any
    return { host, commands }
  }
  const quoted = (cmd: string) => cmd.slice(cmd.indexOf("'"))

  it("the driver snapshot (machine data, often > 200 chars with a note) is stored whole", async () => {
    const { host, commands } = hostWithFakeControl()
    const snapshot = JSON.stringify({
      driver: { kind: "human", id: "user_dev", name: "Dev", avatarUrl: "/a.png", since: 1, note: null },
      priorAgent: { kind: "agent", id: "agent_e280bc28935cf997", name: "Rex", avatarUrl: "http://localhost:3000/static/rex.png" },
      handedBack: { by: { id: "user_dev", name: "Dev" }, note: "x".repeat(400), to: "agent_e280bc28935cf997" },
    })
    expect(snapshot.length).toBeGreaterThan(600)
    await host.setWindowOption("@1", "@teros_driver", snapshot)
    expect(quoted(commands[0])).toBe(tmuxQuote(snapshot))
  })

  it("people's strings (a title) are still cleaned and capped", async () => {
    const { host, commands } = hostWithFakeControl()
    await host.setWindowOption("@1", "@teros_title", `a\u0007b${"t".repeat(300)}`)
    expect(quoted(commands[0])).toBe(tmuxQuote(`a b${"t".repeat(197)}`))
  })
})

describe("terminal host clone of the bash container", () => {
  const inspected = {
    Config: {
      Image: "teros/mca-runtime-bash:latest",
      Env: [
        "MCA_CALLBACK_TOKEN=secret",
        "MCA_APP_ID=app_x",
        "HOME=/app-data/home",
        "PATH=/usr/bin",
        "NODE_ENV=production",
      ],
      WorkingDir: "/app",
    },
    HostConfig: {
      Memory: 2147483648,
      MemorySwap: 2147483648,
      NanoCpus: 2e9,
      PidsLimit: 512,
      SecurityOpt: ["no-new-privileges"],
      CapDrop: ["CAP_NET_RAW"],
      ExtraHosts: ["host.docker.internal:172.17.0.1"],
    },
    Mounts: [
      { Type: "bind", Source: "/srv/mcas/mca.teros.bash", Destination: "/app/mca", RW: false },
      { Type: "bind", Source: "/srv/packages", Destination: "/opt/teros/packages", RW: false },
      { Type: "bind", Source: "/srv/ws/.apps/bash", Destination: "/app-data", RW: true },
      { Type: "bind", Source: "/srv/ws/files", Destination: "/workspace", RW: true },
    ],
    NetworkSettings: { Networks: { "teros-ws-work_1": {}, teros_egress: {} } },
  }

  it("copies limits, hardening, data mounts and networks; never the MCA callback token or source", () => {
    const { run, extraNetworks } = cloneRunArgs(inspected, {
      name: "teros-term-abc-12345678",
      labels: { "teros.term.app": "app_x" },
    })
    const joined = run.join(" ")
    expect(joined).toContain("--init --restart unless-stopped --no-healthcheck")
    expect(joined).toContain(
      "--memory 2147483648b --memory-swap 2147483648b --cpus 2 --pids-limit 512",
    )
    expect(joined).toContain("--security-opt no-new-privileges")
    expect(joined).toContain("--cap-drop CAP_NET_RAW")
    expect(joined).toContain("-v /srv/ws/.apps/bash:/app-data:rw")
    expect(joined).toContain("-v /srv/ws/files:/workspace:rw")
    expect(joined).not.toContain("/app/mca")
    expect(joined).not.toContain("/opt/teros")
    expect(joined).not.toContain("MCA_CALLBACK_TOKEN")
    expect(joined).not.toContain("MCA_APP_ID")
    expect(joined).toContain("-e HOME=/app-data/home")
    expect(joined).toContain("--network teros-ws-work_1")
    expect(extraNetworks).toEqual(["teros_egress"])
    expect(run.slice(-3)).toEqual([
      "--entrypoint",
      "/usr/local/bin/teros-term-host",
      "teros/mca-runtime-bash:latest",
    ])
  })
})

describe("agent heuristics (agents without hooks)", () => {
  const opencodePrompt = [
    "  ┃  Create a file hello.py that prints hello world.",
    "     ← Write hello.py",
    "  ┃  △ Permission required",
    "  ┃    → Edit hello.py",
    '  ┃  1 + print("Hello, World!")',
    "  ┃   Allow once   Allow always   Reject          ctrl+f fullscreen  ⇆ select  enter confirm",
  ]

  it("detects opencode, Claude Code and aider prompts; not ordinary output", () => {
    expect(detectBlocked(opencodePrompt)).toBe("Permission required · Edit hello.py")
    expect(detectBlocked(["Do you want to create hello.py?", "❯ 1. Yes", "  2. No"])).toContain(
      "Do you want to create",
    )
    expect(detectBlocked(["Add hello.py to the chat? (Y)es/(N)o [Yes]:"])).toContain("(Y)es/(N)o")
    expect(detectBlocked(["Compiling...", "test result: ok. 12 passed", "$ "])).toBeNull()
  })

  it("working while output flows, done when it goes quiet, blocked on a prompt", () => {
    const base = { lastHumanInputAt: null, blocked: null }
    expect(
      nextHeuristicState({ ...base, now: 10_000, lastOutputAt: 9_000, previous: "idle" }),
    ).toBe("working")
    expect(
      nextHeuristicState({ ...base, now: 20_000, lastOutputAt: 9_000, previous: "working" }),
    ).toBe("done")
    expect(
      nextHeuristicState({ ...base, now: 20_000, lastOutputAt: 9_000, previous: "done" }),
    ).toBe("done")
    expect(
      nextHeuristicState({
        ...base,
        now: 10_000,
        lastOutputAt: 9_000,
        previous: "working",
        blocked: "Permission required",
      }),
    ).toBe("blocked")
  })

  it("the person's own typing is not the agent working; answering a prompt resumes it", () => {
    expect(
      nextHeuristicState({
        now: 10_000,
        lastOutputAt: 9_500,
        lastHumanInputAt: 9_400,
        previous: "done",
        blocked: null,
      }),
    ).toBe("done")
    expect(
      nextHeuristicState({
        now: 10_000,
        lastOutputAt: 9_500,
        lastHumanInputAt: 9_400,
        previous: "blocked",
        blocked: null,
      }),
    ).toBe("working")
  })
})
