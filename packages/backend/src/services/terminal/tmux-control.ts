/**
 * TmuxControlClient — one tmux control-mode client (`tmux -C attach`) over an
 * ExecStream. A workspace's terminal host runs one tmux server; every Teros
 * terminal is a window of its `teros` session, so this single client carries
 * the output of every session of the workspace.
 *
 * Protocol (tmux 3.2+, "Control mode" in tmux(1)):
 *   - Commands are written one per line; each reply is a `%begin T N F` …
 *     `%end T N F` (or `%error T N F`) block. F & 1 marks replies to commands
 *     this client sent: the initial attach block has F = 0 and is skipped.
 *     Replies come in command order, so pending commands are a FIFO.
 *   - Notifications are single lines outside blocks:
 *       %output %P <escaped>                      raw bytes the pane's app wrote
 *       %extended-output %P <age> … : <escaped>   same, when pause-after is on
 *       %pause %P / %continue %P                  flow control
 *       %window-add @W, %window-close @W, %unlinked-window-close @W
 *       %subscription-changed <name> $S @W <idx> %P … : <value>
 *       %exit [reason]
 *   - Escaping in %output: bytes < 0x20 and backslash are `\ooo` octal, every
 *     other byte (UTF-8 included) is raw. Unescaping is byte-level, before any
 *     UTF-8 decoding — a multi-byte character can straddle two %output lines.
 */

import type { ExecStream } from "./exec-stream"

/** Quote one argument for tmux's command parser (single quotes: no $, ~ or escape processing). */
export function tmuxQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Decode a %output payload (`\ooo` octal escapes, raw bytes otherwise) into bytes. */
export function unescapeOutput(line: Buffer, start: number): Buffer {
  const out = Buffer.allocUnsafe(line.length - start)
  let n = 0
  for (let i = start; i < line.length; i++) {
    const b = line[i]
    if (
      b === 0x5c &&
      i + 3 < line.length &&
      isOctal(line[i + 1]) &&
      isOctal(line[i + 2]) &&
      isOctal(line[i + 3])
    ) {
      out[n++] = ((line[i + 1] - 0x30) << 6) | ((line[i + 2] - 0x30) << 3) | (line[i + 3] - 0x30)
      i += 3
    } else {
      out[n++] = b
    }
  }
  return out.subarray(0, n)
}

function isOctal(b: number | undefined): boolean {
  return b !== undefined && b >= 0x30 && b <= 0x37
}

/** Unescape for command arguments and subscription values (`\ooo` → char). */
function unescapeText(text: string): string {
  return text.replace(/\\([0-7]{3})/g, (_m, oct: string) =>
    String.fromCharCode(Number.parseInt(oct, 8)),
  )
}

export interface SubscriptionChange {
  name: string
  windowId: string
  paneId: string
  value: string
}

export interface TmuxControlHandlers {
  output?: (paneId: string, data: Buffer) => void
  windowAdd?: (windowId: string) => void
  windowClose?: (windowId: string) => void
  subscription?: (change: SubscriptionChange) => void
  pause?: (paneId: string) => void
  /** The control client is gone (tmux exited, the exec died, or close() was called). */
  exit?: (reason: string) => void
}

interface PendingCommand {
  resolve: (lines: string[]) => void
  reject: (err: Error) => void
  /** Runs synchronously when the reply is parsed, before any later notification is handled. */
  onReply?: () => void
}

export class TmuxCommandError extends Error {
  constructor(
    readonly command: string,
    readonly lines: string[],
  ) {
    super(`tmux: ${lines.join(" ").trim() || "command failed"} (${command.split(" ")[0]})`)
  }
}

/** Max bytes of one `send-keys -l` argument; keeps every command line well under tmux's limits. */
const SEND_KEYS_CHUNK = 2048

export class TmuxControlClient {
  private partial: Buffer = Buffer.alloc(0)
  private block: { guard: string; ours: boolean; lines: string[] } | null = null
  private pending: Array<PendingCommand & { command: string }> = []
  private exited = false
  private handlers: TmuxControlHandlers = {}

  constructor(private readonly stream: ExecStream) {
    stream.onData((chunk) => this.feed(chunk))
    stream.onExit((code, stderr) =>
      this.finish(stderr.trim() || `control client exited (${code ?? "signal"})`),
    )
  }

  on(handlers: TmuxControlHandlers): void {
    this.handlers = { ...this.handlers, ...handlers }
  }

  get alive(): boolean {
    return !this.exited
  }

  /** Commands sent and not answered yet. */
  get busy(): boolean {
    return this.pending.length > 0
  }

  /** Run one tmux command; resolves with its output lines, rejects on %error. */
  command(command: string, onReply?: () => void): Promise<string[]> {
    if (this.exited) return Promise.reject(new Error("tmux control client is not connected"))
    if (command.includes("\n"))
      return Promise.reject(new Error("tmux command must be a single line"))
    return new Promise((resolve, reject) => {
      this.pending.push({ command, resolve, reject, onReply })
      this.stream.write(`${command}\n`)
    })
  }

  /**
   * Type raw input into a pane, byte for byte: printable runs as `send-keys -l`
   * (UTF-8 safe), control bytes as `send-keys -H` (hex). Commands are pipelined;
   * the promise resolves once tmux has accepted all of them.
   */
  sendInput(paneId: string, data: string): Promise<void> {
    const commands: string[] = []
    const target = `send-keys -t ${paneId}`
    let literal = ""
    let hex: string[] = []
    const flushLiteral = () => {
      if (literal) commands.push(`${target} -l -- ${tmuxQuote(literal)}`)
      literal = ""
    }
    const flushHex = () => {
      if (hex.length) commands.push(`${target} -H ${hex.join(" ")}`)
      hex = []
    }
    for (const ch of data) {
      const code = ch.codePointAt(0) ?? 0
      if (code < 0x20 || code === 0x7f) {
        flushLiteral()
        hex.push(code.toString(16).padStart(2, "0"))
      } else {
        flushHex()
        literal += ch
        if (literal.length >= SEND_KEYS_CHUNK) flushLiteral()
      }
    }
    flushLiteral()
    flushHex()
    return Promise.all(commands.map((c) => this.command(c))).then(() => undefined)
  }

  close(): void {
    this.stream.close()
    this.finish("closed")
  }

  // ── Parsing ────────────────────────────────────────────────────────────────

  private feed(chunk: Buffer): void {
    let buf = this.partial.length ? Buffer.concat([this.partial, chunk]) : chunk
    let start = 0
    for (;;) {
      const nl = buf.indexOf(0x0a, start)
      if (nl === -1) break
      // tmux ends lines with \n; tolerate \r\n.
      const end = nl > start && buf[nl - 1] === 0x0d ? nl - 1 : nl
      this.line(buf.subarray(start, end))
      start = nl + 1
    }
    buf = buf.subarray(start)
    // Copy so the remainder doesn't pin the whole chunk in memory.
    this.partial = buf.length ? Buffer.from(buf) : Buffer.alloc(0)
  }

  private line(line: Buffer): void {
    if (this.block) {
      if (line[0] === 0x25 /* % */) {
        const text = line.toString("utf8")
        if (text === `%end ${this.block.guard}` || text === `%error ${this.block.guard}`) {
          this.endBlock(text.startsWith("%error"))
          return
        }
      }
      this.block.lines.push(line.toString("utf8"))
      return
    }
    if (line[0] !== 0x25) return
    if (startsWith(line, "%output ")) {
      const sp = line.indexOf(0x20, 8)
      if (sp === -1) return
      this.handlers.output?.(line.toString("latin1", 8, sp), unescapeOutput(line, sp + 1))
      return
    }
    if (startsWith(line, "%extended-output ")) {
      const sp = line.indexOf(0x20, 17)
      const sep = line.indexOf(" : ")
      if (sp === -1 || sep === -1) return
      this.handlers.output?.(line.toString("latin1", 17, sp), unescapeOutput(line, sep + 3))
      return
    }
    const text = line.toString("utf8")
    const [kind, ...rest] = text.split(" ")
    switch (kind) {
      case "%begin": {
        const guard = rest.join(" ")
        const flags = Number(rest[2] ?? 0)
        this.block = { guard, ours: (flags & 1) === 1, lines: [] }
        return
      }
      case "%window-add":
        this.handlers.windowAdd?.(rest[0])
        return
      case "%window-close":
      case "%unlinked-window-close":
        this.handlers.windowClose?.(rest[0])
        return
      case "%pause":
        this.handlers.pause?.(rest[0])
        return
      case "%subscription-changed": {
        // %subscription-changed name $S @W idx %P … : value
        const sep = text.indexOf(" : ")
        if (sep === -1) return
        const head = text.slice(0, sep).split(" ")
        this.handlers.subscription?.({
          name: head[1] ?? "",
          windowId: head[3] ?? "",
          paneId: head[5] ?? "",
          value: unescapeText(text.slice(sep + 3)),
        })
        return
      }
      case "%exit":
        this.finish(rest.join(" ") || "tmux exited")
        return
      default:
        return
    }
  }

  private endBlock(failed: boolean): void {
    const block = this.block
    this.block = null
    if (!block?.ours) return
    const cmd = this.pending.shift()
    if (!cmd) return
    // Promise callbacks run after the rest of this chunk is parsed; onReply
    // marks the exact point in the output stream the reply belongs to.
    cmd.onReply?.()
    if (failed) cmd.reject(new TmuxCommandError(cmd.command, block.lines))
    else cmd.resolve(block.lines)
  }

  private finish(reason: string): void {
    if (this.exited) return
    this.exited = true
    for (const cmd of this.pending.splice(0))
      cmd.reject(new Error(`tmux control client ended: ${reason}`))
    this.handlers.exit?.(reason)
  }
}

function startsWith(buf: Buffer, prefix: string): boolean {
  if (buf.length < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) if (buf[i] !== prefix.charCodeAt(i)) return false
  return true
}
