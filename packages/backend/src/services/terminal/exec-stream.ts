/**
 * ExecStream — a long-lived process inside a container, spoken to over plain
 * pipes (stdin/stdout, no TTY). The terminal domain uses it for one thing: the
 * tmux control-mode client of a workspace's terminal host (`tmux -C attach`).
 *
 * The implementation is the docker CLI (`docker exec -i`), which honours
 * TERMINAL_DOCKER_HOST (ssh:// remote execution hosts, two-host mode) for free.
 * One process per *workspace with live terminals*, never one per session.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "child_process"

export interface ExecStream {
  /** Write raw bytes to the process's stdin. Returns false when the pipe is full (drain pending). */
  write(data: string | Buffer): boolean
  onData(listener: (chunk: Buffer) => void): void
  onExit(listener: (code: number | null, stderr: string) => void): void
  /** Resolves once stdin can take more data (immediately if it already can). */
  drained(): Promise<void>
  close(): void
  readonly pid: number | undefined
}

export interface ExecOptions {
  env?: Record<string, string>
  /** DOCKER_HOST override (TERMINAL_DOCKER_HOST). */
  dockerHost?: string
}

/** Environment for docker CLI children: scoped DOCKER_HOST, never a global one. */
export function dockerCliEnv(dockerHost = process.env.TERMINAL_DOCKER_HOST): NodeJS.ProcessEnv {
  return dockerHost ? { ...process.env, DOCKER_HOST: dockerHost } : process.env
}

export function spawnDockerExec(
  container: string,
  argv: string[],
  options: ExecOptions = {},
): ExecStream {
  const envArgs = Object.entries(options.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`])
  const child: ChildProcessWithoutNullStreams = spawn(
    "docker",
    ["exec", "-i", ...envArgs, container, ...argv],
    {
      env: dockerCliEnv(options.dockerHost),
      stdio: ["pipe", "pipe", "pipe"],
    },
  )
  let stderr = ""
  child.stderr.on("data", (d: Buffer) => {
    // Bounded: a chatty failing exec must not grow the backend's heap.
    if (stderr.length < 4096) stderr += d.toString("utf8")
  })
  // EPIPE on a dead process surfaces through onExit; never crash the backend on it.
  child.stdin.on("error", () => {})
  return {
    write: (data) => child.stdin.writable && child.stdin.write(data),
    onData: (listener) => {
      child.stdout.on("data", listener)
    },
    onExit: (listener) => {
      child.on("close", (code) => listener(code, stderr))
    },
    drained: () =>
      child.stdin.writableNeedDrain
        ? new Promise((resolve) => child.stdin.once("drain", () => resolve()))
        : Promise.resolve(),
    close: () => {
      child.stdin.end()
      child.kill()
    },
    get pid() {
      return child.pid
    },
  }
}
