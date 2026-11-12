/**
 * `terminal.create` launch options for bridge calls (CCR-REQ-2, CCR-REQ-3):
 * extra environment for the session and extra arguments for the coding
 * agent's launch line. Only the backend's own bridge callers send them (the
 * Claude Code runner); a person's Terminal window never does.
 *
 * Strict by construction, so a bridge call can never smuggle a shell
 * fragment or override what the backend injects:
 *   - env keys are `TEROS_*` only (never ANTHROPIC_*, HOME, PATH…), values
 *     are strings up to 64 KiB (an MCP config, a system prompt);
 *   - args are long flags, bare words, or a double-quoted `"$TEROS_*"`
 *     reference — the shell expands the variable, so a secret rides in the
 *     environment and the typed line shows only the variable name.
 *
 * @spec CCR-REQ-2
 * @spec CCR-REQ-3
 */

export interface LaunchOptions {
  env: Record<string, string>
  args: string[]
}

const ENV_KEY = /^TEROS_[A-Z0-9_]{1,64}$/
const MAX_ENV_VALUE = 64 * 1024
const MAX_ENV_VARS = 16
const ARG = /^(--[a-z][a-z0-9-]{0,40}|"\$TEROS_[A-Z0-9_]{1,64}"|[A-Za-z0-9_.,:/=-]{1,200})$/
const MAX_ARGS = 32

/**
 * Validate the raw `launch` field. `undefined`/`null` → null (no options).
 * Throws a RangeError naming the problem — the handler maps it to
 * INVALID_LAUNCH.
 */
export function parseLaunchOptions(raw: unknown): LaunchOptions | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new RangeError("launch must be an object")
  const { env, args } = raw as { env?: unknown; args?: unknown }
  const out: LaunchOptions = { env: {}, args: [] }

  if (env !== undefined) {
    if (env === null || typeof env !== "object" || Array.isArray(env))
      throw new RangeError("launch.env must be an object")
    const entries = Object.entries(env as Record<string, unknown>)
    if (entries.length > MAX_ENV_VARS)
      throw new RangeError(`launch.env takes at most ${MAX_ENV_VARS} variables`)
    for (const [key, value] of entries) {
      if (!ENV_KEY.test(key)) throw new RangeError(`launch.env: "${key}" is not a TEROS_* name`)
      if (typeof value !== "string") throw new RangeError(`launch.env.${key} must be a string`)
      if (value.length > MAX_ENV_VALUE)
        throw new RangeError(`launch.env.${key} is longer than ${MAX_ENV_VALUE} characters`)
      out.env[key] = value
    }
  }

  if (args !== undefined) {
    if (!Array.isArray(args)) throw new RangeError("launch.args must be an array of strings")
    if (args.length > MAX_ARGS) throw new RangeError(`launch.args takes at most ${MAX_ARGS} items`)
    for (const arg of args) {
      if (typeof arg !== "string" || !ARG.test(arg)) {
        throw new RangeError(`launch.args: ${JSON.stringify(arg)} is not an allowed argument`)
      }
      out.args.push(arg)
    }
  }
  return out
}

/** The launch line with the (already validated) args appended. */
export function appendLaunchArgs(line: string, args: readonly string[]): string {
  return args.length === 0 ? line : `${line} ${args.join(" ")}`
}
