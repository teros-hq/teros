/**
 * PtyManager — buffer circular, read/waitFor, ninguna sesión muere sola y introspección.
 *
 * El manager se ejercita con PTYs falsos inyectados vía _setupAndStore (los
 * paths create()/createHost() reales spawn procesos — fuera de alcance de
 * unit): el fake reproduce el contrato node-pty que el manager usa
 * (onData/onExit/write/resize/kill/pid) y permite emitir output sintético.
 * El sweep de ciclo de vida se invoca directamente con un reloj falso.
 */

import { describe, expect, it } from "bun:test"
import {
  HOST_CONTAINER_ID,
  hostPtyEnv,
  MAX_BUFFER_BYTES,
  MAX_BUFFER_LINES,
  PtyManager,
  stripAnsi,
} from "../../src/services/pty-manager"

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Fake fiel al contrato node-pty.IPty que usa PtyManager. */
function makeFakePty(pid = 424242) {
  const dataListeners: Array<(d: string) => void> = []
  const exitListeners: Array<(e: { exitCode: number }) => void> = []
  const calls = { write: [] as string[], resize: [] as Array<[number, number]>, kill: 0 }
  return {
    pid,
    calls,
    write: (d: string) => {
      calls.write.push(d)
    },
    resize: (cols: number, rows: number) => {
      calls.resize.push([cols, rows])
    },
    kill: () => {
      calls.kill++
    },
    onData: (cb: (d: string) => void) => {
      dataListeners.push(cb)
    },
    onExit: (cb: (e: { exitCode: number }) => void) => {
      exitListeners.push(cb)
    },
    emitData: (d: string) => {
      for (const cb of dataListeners) cb(d)
    },
    emitExit: (exitCode = 0) => {
      for (const cb of exitListeners) cb({ exitCode })
    },
  }
}

function makePubSub() {
  const broadcasts: Array<{ topic: string; event: Record<string, unknown> }> = []
  return {
    broadcasts,
    broadcastToTopic(topic: string, event: Record<string, unknown>) {
      broadcasts.push({ topic, event })
    },
  }
}

/** Manager + sesión sembrada con un PTY falso (container 'host', owner work_1). */
function setup(opts: { freezeAfterMs?: number; terminalId?: string } = {}) {
  const pubSub = makePubSub()
  const manager = new PtyManager(pubSub as any, { freezeAfterMs: opts.freezeAfterMs })
  const pty = makeFakePty()
  const terminalId = opts.terminalId ?? "t1"
  ;(manager as any)._setupAndStore(terminalId, pty, "host", "work_1")
  return { manager, pubSub, pty, terminalId }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// stripAnsi
// ---------------------------------------------------------------------------

describe("stripAnsi", () => {
  it("strips CSI color and cursor sequences", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m plain")).toBe("red plain")
    expect(stripAnsi("\x1b[2J\x1b[Hcleared")).toBe("cleared")
    expect(stripAnsi("a\x1b[1;32mgreen\x1b[m b")).toBe("agreen b")
  })

  it("strips OSC sequences (BEL and ST terminated)", () => {
    expect(stripAnsi("\x1b]0;my title\x07prompt$ ")).toBe("prompt$ ")
    expect(stripAnsi("\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\")).toBe("link")
  })

  it("strips colon-separated sub-params and C1 controls", () => {
    expect(stripAnsi("\x1b[38:5:196mcolored\x1b[0m")).toBe("colored")
    expect(stripAnsi("a\u009b31mC1\u009b0m b")).toBe("aC1 b")
  })

  it("leaves plain text untouched", () => {
    expect(stripAnsi("hello world [not an escape]")).toBe("hello world [not an escape]")
  })
})

// ---------------------------------------------------------------------------
// Buffer + read
// ---------------------------------------------------------------------------

describe("read", () => {
  it("buffers complete lines and strips ANSI by default", () => {
    const { manager, pty } = setup()
    pty.emitData("\x1b[32mhello\x1b[0m world\r\nsecond line\n")

    const result = manager.read("t1")
    expect(result.lines).toEqual(["hello world", "second line"])
    expect(result.fromLine).toBe(0)
    expect(result.nextLine).toBe(2)
    expect(result.truncated).toBe(false)
    expect(result.notFound).toBeUndefined()
  })

  it("keeps raw output with raw: true", () => {
    const { manager, pty } = setup()
    pty.emitData("\x1b[31mred\x1b[0m\n")
    expect(manager.read("t1", { raw: true }).lines).toEqual(["\x1b[31mred\x1b[0m"])
    expect(manager.read("t1").lines).toEqual(["red"])
  })

  it("carries partial lines across chunks (no split artifacts)", () => {
    const { manager, pty } = setup()
    pty.emitData("hel")
    pty.emitData("lo w")
    pty.emitData("orld\n")
    expect(manager.read("t1").lines).toEqual(["hello world"])
  })

  it("handles lone \r (progress-bar style) as part of the line, not a separator", () => {
    const { manager, pty } = setup()
    pty.emitData("10%\r50%\r100% done\n")
    // \r no separa líneas (solo \n lo hace) y se preserva en el contenido:
    // fiel al stream, igual que strip-ansi (que tampoco toca \r).
    expect(manager.read("t1").lines).toEqual(["10%\r50%\r100% done"])
  })

  it("returns the last N lines with lines: N", () => {
    const { manager, pty } = setup()
    pty.emitData("l0\nl1\nl2\nl3\nl4\n")
    const result = manager.read("t1", { lines: 2 })
    expect(result.lines).toEqual(["l3", "l4"])
    expect(result.fromLine).toBe(3)
    expect(result.nextLine).toBe(5)
  })

  it("supports cursor-based incremental reads via fromLine/nextLine", () => {
    const { manager, pty } = setup()
    pty.emitData("a\nb\n")
    const first = manager.read("t1", { fromLine: 0 })
    expect(first.lines).toEqual(["a", "b"])

    pty.emitData("c\n")
    const second = manager.read("t1", { fromLine: first.nextLine })
    expect(second.lines).toEqual(["c"])
    expect(second.fromLine).toBe(2)
    expect(second.nextLine).toBe(3)
  })

  it("returns notFound for unknown sessions", () => {
    const { manager } = setup()
    const result = manager.read("missing")
    expect(result.lines).toEqual([])
    expect(result.notFound).toBe(true)
  })
})

describe("circular buffer caps", () => {
  it("keeps only the last MAX_BUFFER_LINES lines and flags truncated", () => {
    const { manager, pty } = setup()
    const total = MAX_BUFFER_LINES + 100
    pty.emitData(Array.from({ length: total }, (_, i) => `line-${i}`).join("\n") + "\n")

    const result = manager.read("t1", { lines: MAX_BUFFER_LINES })
    expect(result.lines).toHaveLength(MAX_BUFFER_LINES)
    expect(result.lines[0]).toBe(`line-${total - MAX_BUFFER_LINES}`)
    expect(result.lines.at(-1)).toBe(`line-${total - 1}`)
    expect(result.truncated).toBe(true)
    expect(result.fromLine).toBe(total - MAX_BUFFER_LINES)
  })

  it("enforces the byte cap by dropping oldest lines", () => {
    const { manager, pty } = setup()
    const big = "x".repeat(200 * 1024) // 2 líneas de 200KB > 256KB en total
    pty.emitData(big + "\n" + big.replace(/x/g, "y") + "\n")

    const result = manager.read("t1")
    expect(result.truncated).toBe(true)
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0]).toBe("y".repeat(200 * 1024))
    expect(manager.getStatus("t1")!.bufferBytes).toBeLessThanOrEqual(MAX_BUFFER_BYTES)
  })
})

// ---------------------------------------------------------------------------
// waitFor
// ---------------------------------------------------------------------------

describe("waitFor", () => {
  it("resolves immediately when the pattern is already buffered", async () => {
    const { manager, pty } = setup()
    pty.emitData("deploy done\n")
    const result = await manager.waitFor("t1", /done/)
    expect(result.matched).toBe(true)
    expect(result.line).toBe("deploy done")
    expect(result.lineIndex).toBe(0)
    expect(result.nextLine).toBe(1)
  })

  it("resolves when matching output arrives later", async () => {
    const { manager, pty } = setup()
    const pending = manager.waitFor("t1", "READY")
    pty.emitData("starting\n")
    pty.emitData("now READY\n")
    const result = await pending
    expect(result.line).toBe("now READY")
    expect(result.lineIndex).toBe(1)
  })

  it("matches against ANSI-stripped lines by default", async () => {
    const { manager, pty } = setup()
    const pending = manager.waitFor("t1", /success/)
    pty.emitData("\x1b[32msuccess\x1b[0m\n")
    const result = await pending
    expect(result.line).toBe("success")
  })

  it("can match raw output with raw: true", async () => {
    const { manager, pty } = setup()
    const pending = manager.waitFor("t1", new RegExp("\\x1b\\[31m"), { raw: true })
    pty.emitData("\x1b[31mred\x1b[0m\n")
    const result = await pending
    expect(result.line).toBe("\x1b[31mred\x1b[0m")
  })

  it("rejects with timeout when the pattern never arrives", async () => {
    const { manager } = setup()
    await expect(manager.waitFor("t1", /never/, { timeoutMs: 50 })).rejects.toThrow(
      "timeout after 50ms",
    )
  })

  it("honors fromLine cursor (does not rematch old lines)", async () => {
    const { manager, pty } = setup()
    pty.emitData("tick\n")
    const first = await manager.waitFor("t1", /tick/)
    expect(first.lineIndex).toBe(0)

    const pending = manager.waitFor("t1", /tick/, { fromLine: first.nextLine, timeoutMs: 80 })
    await sleep(20)
    pty.emitData("tick\n")
    const second = await pending
    expect(second.lineIndex).toBe(1)
  })

  it("accepts string patterns (converted to RegExp)", async () => {
    const { manager, pty } = setup()
    pty.emitData("value=42\n")
    const result = await manager.waitFor("t1", "value=\\d+")
    expect(result.line).toBe("value=42")
  })

  it("rejects for unknown sessions", async () => {
    const { manager } = setup()
    await expect(manager.waitFor("missing", /x/)).rejects.toThrow("no session")
  })

  it("rejects pending waiters when the session is destroyed", async () => {
    const { manager, pty } = setup()
    const pending = manager.waitFor("t1", /later/, { timeoutMs: 5000 })
    pty.emitExit(1)
    await expect(pending).rejects.toThrow("session t1 ended")
  })

  it("does not resolve a waiter twice on repeated matches", async () => {
    const { manager, pty } = setup()
    const pending = manager.waitFor("t1", /dup/, { timeoutMs: 500 })
    pty.emitData("dup\n")
    await pending
    // Sin rechazo por doble resolve ni unhandled rejection:
    pty.emitData("dup\n")
    await sleep(30)
    expect(true).toBe(true)
  })

  // ── T-004: el eco del propio comando no es un match ──────────────────────

  it("T-004: write+waitFor inmediato NO matchea el eco del comando — espera al output real", async () => {
    const { manager, pty } = setup()
    pty.emitData("agent@teros:~$ ") // prompt parcial pendiente

    // Reproducción del audit: write('sleep 3 && echo AUDIT-WAITFOR-OK') + waitFor inmediato.
    // El TTY re-echa la línea tecleada; el patrón aparece literalmente en el eco.
    manager.write("t1", "sleep 3 && echo AUDIT-WAITFOR-OK\r")
    const pending = manager.waitFor("t1", /AUDIT-WAITFOR-OK/, { timeoutMs: 500 })

    // El eco llega primero (prompt + comando tecleado, línea completa):
    pty.emitData("sleep 3 && echo AUDIT-WAITFOR-OK\r\n")
    await sleep(30)
    // No debe haber resuelto contra el eco — sigue pendiente.
    let settled = false
    void pending.then(
      () => (settled = true),
      () => (settled = true),
    )
    await sleep(30)
    expect(settled).toBe(false)

    // El output real llega después (tras el "sleep"):
    pty.emitData("AUDIT-WAITFOR-OK\r\n")
    const result = await pending
    expect(result.matched).toBe(true)
    expect(result.line).toBe("AUDIT-WAITFOR-OK")
    expect(result.line).not.toContain("sleep 3")
  })

  it("T-004: waitFor sin fromLine no matchea ocurrencias ANTERIORES al último write", async () => {
    const { manager, pty } = setup()
    // Ocurrencia vieja del patrón en el buffer (de un comando anterior):
    pty.emitData("build DONE\n")
    manager.write("t1", "make build\r") // cursor queda tras esa línea
    pty.emitData("make build\r\n") // eco del nuevo comando

    const pending = manager.waitFor("t1", /DONE/, { timeoutMs: 200 })
    // Ni la línea vieja ('build DONE') ni el eco sirven — llega output nuevo:
    pty.emitData("compiling...\r\nALL DONE\r\n")
    const result = await pending
    expect(result.line).toBe("ALL DONE")
    expect(result.lineIndex).toBe(3)
  })

  it("T-004: waitFor con fromLine explícito sigue pudiendo buscar en output viejo", async () => {
    const { manager, pty } = setup()
    pty.emitData("old marker\n")
    manager.write("t1", "echo hi\r")
    // fromLine: 0 fuerza búsqueda desde el principio del buffer (override manual):
    const result = await manager.waitFor("t1", /old marker/, { fromLine: 0 })
    expect(result.line).toBe("old marker")
    expect(result.lineIndex).toBe(0)
  })

  it("T-004: write devuelve el cursor post-write (1 línea reservada para el eco)", async () => {
    const { manager, pty } = setup()
    pty.emitData("line0\nline1\n")
    const cursor = manager.write("t1", "echo hi\r")
    expect(cursor).toBe(3) // bufferStartLine(0) + 2 líneas + 1 reservada para el eco

    pty.emitData("prompt$ ") // línea parcial pendiente — el eco la ocupará
    const cursor2 = manager.write("t1", "ls\r")
    expect(cursor2).toBe(3) // mismo cálculo: el eco va en la pendiente (índice 2), output desde 3
  })

  it("T-004: write en sesión inexistente devuelve undefined (no rompe)", () => {
    const { manager } = setup()
    expect(manager.write("missing", "x")).toBeUndefined()
  })

  it("T-004: write con moveCursor:false (keystrokes UI) NO mueve la ventana de waitFor", async () => {
    const { manager, pty } = setup()
    pty.emitData("READY\n")
    // Keystroke crudo (flecha, ctrl-c, …) — no es un comando nuevo:
    const ret = manager.write("t1", "\x1b[A", { moveCursor: false })
    expect(ret).toBeUndefined()
    // El waitFor sin fromLine sigue viendo el output anterior (cursor intacto en 0):
    const result = await manager.waitFor("t1", /READY/)
    expect(result.line).toBe("READY")
  })
})

// ---------------------------------------------------------------------------
// Lifecycle: no auto-destroy
// ---------------------------------------------------------------------------

describe("no session dies on its own (it sleeps instead)", () => {
  it("an idle session survives any amount of idle time — even one nobody watches", () => {
    const { manager, pty, pubSub } = setup({ freezeAfterMs: 50 })
    pty.emitData("out\n")
    const session = (manager as any).sessions.get("t1")
    session.lastActivity = new Date(Date.now() - 365 * 24 * 3600_000)
    ;(manager as any)._lifecycleSweep(Date.now() + 365 * 24 * 3600_000)
    expect(manager.has("t1")).toBe(true)
    expect(pty.calls.kill).toBe(0)
    expect(pubSub.broadcasts.filter((b) => b.event.type === "terminal_exit")).toHaveLength(0)
  })

  it("a session without a terminal host (legacy PTY) stays awake: nothing to freeze", () => {
    const { manager } = setup({ freezeAfterMs: 50 })
    ;(manager as any)._lifecycleSweep(Date.now() + 3600_000)
    expect(manager.describe("t1")?.lifecycle).toBe("awake")
  })

  it("only destroy() or the process exiting ends a session", () => {
    const { manager, pty, pubSub } = setup()
    manager.destroy("t1")
    expect(manager.has("t1")).toBe(false)
    pty.emitExit(0)
    const exits = pubSub.broadcasts.filter((b) => b.event.type === "terminal_exit")
    expect(exits).toHaveLength(1)
  })

  it("list() and getStatus() do NOT count as activity", () => {
    const { manager } = setup()
    const session = (manager as any).sessions.get("t1")
    const frozen = Date.now() - 10_000
    session.lastActivity = new Date(frozen)
    manager.list()
    manager.getStatus("t1")
    expect(session.lastActivity.getTime()).toBe(frozen)
  })

  it("write/read/resize count as activity", () => {
    const { manager } = setup()
    const session = (manager as any).sessions.get("t1")
    for (const use of [
      () => manager.write("t1", "ls\n"),
      () => manager.read("t1"),
      () => manager.resize("t1", 100, 30),
    ]) {
      session.lastActivity = new Date(Date.now() - 10_000)
      use()
      expect(Date.now() - session.lastActivity.getTime()).toBeLessThan(1000)
    }
  })
})

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

describe("list and getStatus", () => {
  it("lists active sessions with metadata", () => {
    const { manager } = setup({ terminalId: "t-a" })
    ;(manager as any)._setupAndStore("t-b", makeFakePty(), "mca-teros-bash-12345678", "work_2")

    const sessions = manager.list()
    expect(sessions).toHaveLength(2)

    const a = sessions.find((s) => s.terminalId === "t-a")!
    expect(a.containerId).toBe("host")
    expect(a.ownerWorkspaceId).toBe("work_1")
    expect(a.alive).toBe(true)
    expect(a.createdAt).toBeInstanceOf(Date)
    expect(a.lastActivity).toBeInstanceOf(Date)
    expect(a.lifecycle).toBe("awake")
    expect(a.pinned).toBe(true) // deprecated: every session is kept
    expect(a.bufferSize).toBe(0)

    const b = sessions.find((s) => s.terminalId === "t-b")!
    expect(b.containerId).toBe("mca-teros-bash-12345678")
    expect(b.ownerWorkspaceId).toBe("work_2")
  })

  it("reports bufferSize in list() after output", () => {
    const { manager, pty } = setup()
    pty.emitData("one\ntwo\n")
    expect(manager.list()[0].bufferSize).toBe(2)
  })

  it("getStatus returns buffer cursors and byte size", () => {
    const { manager, pty } = setup()
    pty.emitData("aaa\nbbb\n")
    const status = manager.getStatus("t1")!
    expect(status.bufferStartLine).toBe(0)
    expect(status.bufferNextLine).toBe(2)
    expect(status.bufferSize).toBe(2)
    expect(status.bufferBytes).toBe(6)
    expect(status.lastOutputAt).toBeInstanceOf(Date)
    expect(status.alive).toBe(true)
  })

  it("getStatus returns null for unknown sessions", () => {
    const { manager } = setup()
    expect(manager.getStatus("missing")).toBeNull()
  })

  it("alive is false once the PTY process reports no pid", () => {
    const { manager, pty } = setup()
    ;(pty as any).pid = undefined
    expect(manager.getStatus("t1")!.alive).toBe(false)
    expect(manager.list()[0].alive).toBe(false)
  })

  it("foregroundProcess is null for fake PTYs without real children (best-effort)", () => {
    const { manager } = setup()
    // pid 424242 no existe → ps no devuelve hijo → null (no lanza)
    expect(manager.getStatus("t1")!.foregroundProcess).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Compatibilidad con la superficie existente
// ---------------------------------------------------------------------------

describe("existing surface stays intact", () => {
  it("has() and ownerOf() work as before", () => {
    const { manager } = setup()
    expect(manager.has("t1")).toBe(true)
    expect(manager.has("nope")).toBe(false)
    expect(manager.ownerOf("t1")).toBe("work_1")
    expect(manager.ownerOf("nope")).toBeUndefined()
  })

  it("write() forwards to the PTY and does not buffer input", () => {
    const { manager, pty } = setup()
    manager.write("t1", "echo hi\r")
    expect(pty.calls.write).toEqual(["echo hi\r"])
    expect(manager.read("t1").lines).toEqual([])
    manager.write("missing", "x") // no-op, no lanza
  })

  it("resize() forwards to the PTY", () => {
    const { manager, pty } = setup()
    manager.resize("t1", 120, 40)
    expect(pty.calls.resize).toEqual([[120, 40]])
    manager.resize("missing", 1, 1) // no-op, no lanza
  })

  it("destroy() kills the PTY and removes the session", () => {
    const { manager, pty, pubSub } = setup()
    manager.destroy("t1")
    expect(pty.calls.kill).toBe(1)
    expect(manager.has("t1")).toBe(false)
    expect(manager.read("t1").notFound).toBe(true)
    // destroy() directo no emite terminal_exit (lo hará onExit real)
    expect(pubSub.broadcasts.filter((b) => b.event.type === "terminal_exit")).toHaveLength(0)
  })

  it("output keeps broadcasting terminal_output to the pubsub topic", () => {
    const { manager, pty, pubSub } = setup()
    pty.emitData("hello\n")
    const outs = pubSub.broadcasts.filter((b) => b.event.type === "terminal_output")
    expect(outs).toHaveLength(1)
    expect(outs[0].topic).toBe("terminal:t1")
    expect(outs[0].event.data).toBe("hello\n")
    expect(outs[0].event.terminalId).toBe("t1")
  })

  it("natural PTY exit cleans up and broadcasts terminal_exit without reason", () => {
    const { manager, pty, pubSub } = setup()
    pty.emitExit(3)
    expect(manager.has("t1")).toBe(false)
    const exitEvents = pubSub.broadcasts.filter((b) => b.event.type === "terminal_exit")
    expect(exitEvents).toHaveLength(1)
    expect(exitEvents[0].event.exitCode).toBe(3)
    expect(exitEvents[0].event.reason).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// hostPtyEnv — el shell del host no hereda los secretos del backend
// ---------------------------------------------------------------------------

describe("hostPtyEnv", () => {
  it("conserva solo el allowlist + LC_*, fuerza TERM y descarta todo lo demás", () => {
    const env = hostPtyEnv({
      PATH: "/usr/bin:/bin",
      HOME: "/root",
      USER: "root",
      LANG: "en_US.UTF-8",
      LC_ALL: "C.UTF-8",
      TERM: "dumb",
      MONGODB_URI: "mongodb://user:pass@db/teros",
      STRIPE_SECRET_KEY: "sk_live_x",
      ENCRYPTION_KEY: "k",
      ANTHROPIC_API_KEY: "a",
      NODE_OPTIONS: "--import dd-trace/initialize.mjs",
      UNSET: undefined,
    })
    expect(env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/root",
      USER: "root",
      LANG: "en_US.UTF-8",
      LC_ALL: "C.UTF-8",
      TERM: "xterm-256color",
    })
  })
})

describe("isHost", () => {
  it("true solo para sesiones con containerId host", () => {
    const manager = new PtyManager(makePubSub() as any)
    ;(manager as any)._setupAndStore("t_host", makeFakePty(), HOST_CONTAINER_ID, "work_1")
    ;(manager as any)._setupAndStore("t_docker", makeFakePty(), "mca-teros-bash-12345678", "work_1")
    expect(manager.isHost("t_host")).toBe(true)
    expect(manager.isHost("t_docker")).toBe(false)
    expect(manager.isHost("t_gone")).toBe(false)
  })
})
