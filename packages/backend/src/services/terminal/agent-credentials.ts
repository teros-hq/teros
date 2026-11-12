/**
 * Coding-agent credentials for Terminal sessions — per USER, never per
 * workspace.
 *
 * A person picks, once, how Claude Code (or Codex / opencode) signs in:
 *   teros         — through one of their Teros providers that can serve the
 *                   agent (Claude Code: an `anthropic` provider's key, or the
 *                   Anthropic-compatible `minimax` endpoint). Nothing stored
 *                   here but the provider id; the key is read at session start.
 *   subscription  — Claude Pro/Max: the person's own Claude account, from
 *                   `claude auth login` run privately (loginStart /
 *                   loginFinish, completed in the Terminal window). Stored:
 *                   Claude Code's credential (access + refresh token) and the
 *                   account record, so sessions open AS that account (banner,
 *                   plan, default model, /status). Older records hold a
 *                   `claude setup-token` token (inference only, env-injected).
 *   apiKey        — a pasted key.
 * Secrets are encrypted with the user's key (auth/user-keys.ts, scope
 * `coding_agent_credentials:<agent>`), never written to the workspace's disk,
 * and injected as environment only into sessions that person opens — or, when
 * they turn on "share with this workspace's agents", into Claude sessions a
 * Teros agent of that workspace opens.
 *
 * Account sign-ins reach a session as a private CLAUDE_CONFIG_DIR on the
 * host's tmpfs (/dev/shm, never the workspace volume), materialized at
 * session start and synced back when Claude Code refreshes the token.
 *
 * Caveat (documented in the terminal-gem report): the terminal host is one
 * container per workspace and every writer gets a root shell in it, so a
 * running session's environment (/proc) and the config dir on /dev/shm are
 * readable by other writers of the same workspace. Neither is on the
 * workspace's disk; /dev/shm is gone when the host restarts.
 */

import { createHash } from "crypto"

import type { Db } from "mongodb"
import { AAD_FORMAT, decryptForUser, encryptForUser } from "../../auth/user-keys"
import { COLLECTIONS, collection } from "../../db"
import type { ProviderService } from "../provider-service"

export type CodingAgent = "claude" | "codex" | "opencode"
export type AgentAuthMode = "teros" | "subscription" | "apiKey"

export const CODING_AGENTS: readonly CodingAgent[] = ["claude", "codex", "opencode"]

export function isCodingAgent(v: unknown): v is CodingAgent {
  return typeof v === "string" && (CODING_AGENTS as readonly string[]).includes(v)
}

interface StoredCredential {
  userId: string
  agent: CodingAgent
  mode: AgentAuthMode
  /** teros mode: the user's provider. */
  providerId?: string
  /** subscription/apiKey: encrypted { secret }. */
  encryptedData?: string
  encryptionIv?: string
  encryptionTag?: string
  encryptionFormat?: number
  /** subscription: "account" (Claude Code's own credential + account) or "token" (legacy setup-token). */
  kind?: "account" | "token"
  /** Shown in the chip (never the secret): "API key ····abcd", "you@x.com (Max)". */
  label: string
  /** Workspaces whose Teros agents may use these credentials. */
  sharedWorkspaces: string[]
  updatedAt: Date
}

/** What the window sees: never a secret. */
export interface AgentAuthStatus {
  agent: CodingAgent
  mode: AgentAuthMode | null
  label: string | null
  teros: { available: boolean; label?: string }
  shared: boolean
}

/** Claude Code's own credential (~/.claude/.credentials.json → claudeAiOauth); kept verbatim. */
export interface ClaudeOauth {
  accessToken: string
  refreshToken?: string
  expiresAt: number
  scopes?: string[]
  subscriptionType?: string | null
  [field: string]: unknown
}

/** A person's Claude account as Claude Code keeps it: credential + ~/.claude.json oauthAccount. */
export interface ClaudeAccount {
  claudeAiOauth: ClaudeOauth
  oauthAccount: { emailAddress?: string; [field: string]: unknown }
}

/** What a Claude session needs to open as the person's account. */
export interface ClaudeAccountSession {
  dir: string
  account: ClaudeAccount
}

/** Private CLAUDE_CONFIG_DIR of a person on a terminal host (tmpfs, not the workspace volume). */
export function claudeConfigDir(userId: string): string {
  return `/dev/shm/teros-claude/${createHash("sha256").update(userId).digest("hex").slice(0, 16)}`
}

const PLAN_NAMES: Record<string, string> = {
  max: "Max",
  pro: "Pro",
  team: "Team",
  enterprise: "Enterprise",
}

/** Chip text for an account sign-in: "you@x.com (Max)". */
export function accountLabel(account: ClaudeAccount): string {
  const email = account.oauthAccount.emailAddress
  const type = account.claudeAiOauth.subscriptionType ?? ""
  const plan = PLAN_NAMES[type] ?? (type ? type : null)
  if (!email) return plan ? `Claude ${plan}` : "Claude account"
  return plan ? `${email} (${plan})` : email
}

/** A credential read back from a host, if it has the shape Claude Code writes. */
export function asClaudeOauth(value: unknown): ClaudeOauth | null {
  if (!value || typeof value !== "object") return null
  const v = value as Partial<ClaudeOauth>
  return typeof v.accessToken === "string" && typeof v.expiresAt === "number"
    ? (v as ClaudeOauth)
    : null
}

/** Which copy of the credential is current: the stored one or the one in a session's dir. */
export function fresherCredential(
  stored: ClaudeOauth,
  inDir: ClaudeOauth | null,
): "stored" | "dir" | "same" {
  if (!inDir) return "stored"
  if (inDir.accessToken === stored.accessToken && inDir.refreshToken === stored.refreshToken)
    return "same"
  return (inDir.expiresAt ?? 0) > (stored.expiresAt ?? 0) ? "dir" : "stored"
}

/** Provider types that can serve each agent through Teros, best first. */
const TEROS_PROVIDERS: Record<CodingAgent, string[]> = {
  claude: ["anthropic", "minimax"],
  codex: ["openai"],
  opencode: ["anthropic", "openai"],
}

const MINIMAX_ANTHROPIC_URL = "https://api.minimax.io/anthropic"

/** Last four characters, the only part of a key ever shown. */
export function keyHint(secret: string): string {
  return `····${secret.slice(-4)}`
}

/** Environment a session gets for each agent and mode. */
export function envForSecret(
  agent: CodingAgent,
  mode: AgentAuthMode,
  secret: string,
): Record<string, string> {
  if (agent === "claude") {
    return mode === "subscription"
      ? { CLAUDE_CODE_OAUTH_TOKEN: secret }
      : { ANTHROPIC_API_KEY: secret }
  }
  if (agent === "opencode" && secret.startsWith("sk-ant-")) return { ANTHROPIC_API_KEY: secret }
  return { OPENAI_API_KEY: secret }
}

/** The chip text; a setup-token sign-in works, but Claude Code can't tell whose account it is. */
function shownLabel(doc: StoredCredential): string {
  return doc.mode === "subscription" && doc.kind !== "account"
    ? `${doc.label} · limited, sign in again`
    : doc.label
}

export class AgentCredentialStore {
  constructor(
    private readonly db: Db,
    private readonly providers: ProviderService | null,
  ) {}

  private col() {
    return collection<StoredCredential>(this.db, COLLECTIONS.codingAgentCredentials)
  }

  private scope(agent: CodingAgent): string {
    return `coding_agent_credentials:${agent}`
  }

  /** The user's provider that can serve `agent` through Teros, if any. */
  async terosProvider(
    userId: string,
    agent: CodingAgent,
  ): Promise<{ providerId: string; providerType: string; label: string } | null> {
    if (!this.providers) return null
    const list = await this.providers.listUserProviders(userId)
    for (const type of TEROS_PROVIDERS[agent]) {
      const p = list.find((x) => x.providerType === type && (x.status ?? "active") === "active")
      if (p) return { providerId: p.providerId, providerType: type, label: p.displayName || type }
    }
    return null
  }

  async status(userId: string, agent: CodingAgent, workspaceId?: string): Promise<AgentAuthStatus> {
    const doc = await this.col().findOne({ userId, agent })
    const teros = await this.terosProvider(userId, agent)
    return {
      agent,
      mode: doc?.mode ?? null,
      label: doc ? shownLabel(doc) : null,
      teros: teros ? { available: true, label: teros.label } : { available: false },
      shared: workspaceId ? (doc?.sharedWorkspaces ?? []).includes(workspaceId) : false,
    }
  }

  async useTeros(userId: string, agent: CodingAgent): Promise<void> {
    const teros = await this.terosProvider(userId, agent)
    if (!teros) throw new Error("No Teros provider can serve this agent")
    await this.col().updateOne(
      { userId, agent },
      {
        $set: {
          mode: "teros",
          providerId: teros.providerId,
          label: `via Teros (${teros.label})`,
          updatedAt: new Date(),
        },
        $unset: {
          encryptedData: "",
          encryptionIv: "",
          encryptionTag: "",
          encryptionFormat: "",
          kind: "",
        },
        $setOnInsert: { sharedWorkspaces: [] },
      },
      { upsert: true },
    )
  }

  async setSecret(
    userId: string,
    agent: CodingAgent,
    mode: "subscription" | "apiKey",
    secret: string,
    label: string,
  ): Promise<void> {
    await this.store(
      userId,
      agent,
      mode,
      { secret },
      label,
      mode === "subscription" ? "token" : undefined,
    )
  }

  /** A Claude account sign-in (claude auth login): sessions open as this account. */
  async setAccount(userId: string, account: ClaudeAccount): Promise<string> {
    const label = accountLabel(account)
    await this.store(userId, "claude", "subscription", { account }, label, "account")
    return label
  }

  /**
   * Claude Code refreshed the token inside a session's dir: keep that copy if
   * it is newer than the stored one. Returns what happened, for the log.
   */
  async syncAccountCredential(
    userId: string,
    inDir: ClaudeOauth | null,
  ): Promise<"stored-newer" | "dir-newer" | "same" | "none"> {
    const current = await this.account(userId)
    if (!current) return "none"
    const which = fresherCredential(current.claudeAiOauth, inDir)
    if (which !== "dir" || !inDir) return which === "same" ? "same" : "stored-newer"
    const doc = await this.col().findOne({ userId, agent: "claude" })
    await this.store(
      userId,
      "claude",
      "subscription",
      { account: { ...current, claudeAiOauth: inDir } },
      doc?.label ?? accountLabel(current),
      "account",
    )
    return "dir-newer"
  }

  /** The person's stored Claude account, if they signed in with one. */
  async account(userId: string): Promise<ClaudeAccount | null> {
    const doc = await this.col().findOne({ userId, agent: "claude" })
    if (doc?.mode !== "subscription" || doc.kind !== "account") return null
    const payload = await this.decrypt(userId, "claude", doc)
    return (payload?.account as ClaudeAccount | undefined) ?? null
  }

  private async decrypt(
    userId: string,
    agent: CodingAgent,
    doc: StoredCredential,
  ): Promise<Record<string, unknown> | null> {
    if (!doc.encryptedData || !doc.encryptionIv || !doc.encryptionTag) return null
    return (await decryptForUser(
      this.db,
      userId,
      this.scope(agent),
      { data: doc.encryptedData, iv: doc.encryptionIv, tag: doc.encryptionTag },
      doc.encryptionFormat,
    )) as Record<string, unknown>
  }

  private async store(
    userId: string,
    agent: CodingAgent,
    mode: "subscription" | "apiKey",
    payload: Record<string, unknown>,
    label: string,
    kind: "account" | "token" | undefined,
  ): Promise<void> {
    const enc = await encryptForUser(this.db, userId, this.scope(agent), payload)
    await this.col().updateOne(
      { userId, agent },
      {
        $set: {
          mode,
          ...(kind ? { kind } : {}),
          label,
          encryptedData: enc.data,
          encryptionIv: enc.iv,
          encryptionTag: enc.tag,
          encryptionFormat: AAD_FORMAT,
          updatedAt: new Date(),
        },
        $unset: kind ? { providerId: "" } : { providerId: "", kind: "" },
        $setOnInsert: { sharedWorkspaces: [] },
      },
      { upsert: true },
    )
  }

  async setShared(
    userId: string,
    agent: CodingAgent,
    workspaceId: string,
    shared: boolean,
  ): Promise<void> {
    await this.col().updateOne(
      { userId, agent },
      shared
        ? { $addToSet: { sharedWorkspaces: workspaceId } }
        : { $pull: { sharedWorkspaces: workspaceId } },
    )
  }

  async clear(userId: string, agent: CodingAgent): Promise<void> {
    await this.col().deleteOne({ userId, agent })
  }

  /**
   * Environment for a new session of `agent`. `forWorkspace` is set when a
   * Teros agent of that workspace opens the session on behalf of `userId`
   * (the workspace owner): credentials apply only if the user shared them.
   */
  async env(
    userId: string,
    agent: CodingAgent,
    opts: { forWorkspace?: string } = {},
  ): Promise<{
    env: Record<string, string>
    label: string
    mode: AgentAuthMode
    /** Account sign-in: the private config dir to materialize before the session starts. */
    claude?: ClaudeAccountSession
  } | null> {
    const doc = await this.col().findOne({ userId, agent })
    if (!doc) return null
    if (opts.forWorkspace && !doc.sharedWorkspaces.includes(opts.forWorkspace)) return null
    if (doc.mode === "teros") {
      if (!this.providers || !doc.providerId) return null
      const provider = await this.providers.getProvider(doc.providerId)
      const secrets = await this.providers.getProviderSecrets(userId, doc.providerId)
      if (!provider || !secrets?.apiKey) return null
      if (provider.providerType === "minimax") {
        return {
          env: { ANTHROPIC_BASE_URL: MINIMAX_ANTHROPIC_URL, ANTHROPIC_AUTH_TOKEN: secrets.apiKey },
          label: doc.label,
          mode: doc.mode,
        }
      }
      return {
        env: envForSecret(agent, "apiKey", secrets.apiKey),
        label: doc.label,
        mode: doc.mode,
      }
    }
    const payload = await this.decrypt(userId, agent, doc)
    if (!payload) return null
    if (agent === "claude" && doc.kind === "account" && payload.account) {
      const dir = claudeConfigDir(userId)
      return {
        env: { CLAUDE_CONFIG_DIR: dir },
        label: doc.label,
        mode: doc.mode,
        claude: { dir, account: payload.account as ClaudeAccount },
      }
    }
    if (typeof payload.secret !== "string") return null
    return {
      env: envForSecret(agent, doc.mode, payload.secret),
      label: shownLabel(doc),
      mode: doc.mode,
    }
  }
}

// ── Claude account sign-in (claude auth login, run privately) ──────────────

/** The authorize URL `claude auth login` prints, hard-wrapped at the pane width. */
export function extractLoginUrl(lines: string[], width: number): string | null {
  const start = lines.findIndex((l) => /https:\/\/\S*oauth\/authorize/.test(l))
  if (start === -1) return null
  let url = lines[start].slice(lines[start].indexOf("https://")).trim()
  for (let i = start + 1; i < lines.length && lines[i - 1].length >= width - 1; i++) {
    const next = lines[i].trim()
    if (!next || /\s/.test(next)) break
    url += next
  }
  return url
}

/** The CLI's own failure line ("Login failed: …", "OAuth error: …"), if the screen shows one. */
export function extractLoginError(lines: string[]): string | null {
  const line = lines.find((l) =>
    /Login failed|OAuth error|Invalid code|Press Enter to retry/i.test(l),
  )
  if (!line) return null
  if (/Press Enter to retry/i.test(line)) {
    const before = lines[lines.indexOf(line) - 1]?.trim()
    return before || line.trim()
  }
  // The prompt and the answer share a line: "Paste code here if prompted > Login failed: …"
  return line.slice(line.search(/Login failed|OAuth error|Invalid code/i)).trim()
}

/** What the person reads when Claude rejects their code. */
export function loginErrorMessage(raw: string): string {
  if (/status code 400|invalid_grant|Invalid code/i.test(raw))
    return `Claude rejected that code. Codes work once and expire after a few minutes: start the sign-in again and paste the new code. (${raw})`
  if (/status code 40[13]/i.test(raw))
    return `Claude refused the sign-in for this account; a Pro or Max subscription is required. (${raw})`
  if (/status code 5\d\d|ETIMEDOUT|ECONNRESET|ENOTFOUND|network/i.test(raw))
    return `Claude's sign-in service could not be reached from the workspace. Try again in a moment. (${raw})`
  return raw
}

/** A screen tail safe for logs and error text: no URLs, codes or tokens. */
export function redactScreen(lines: string[], max = 4): string {
  return lines
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-max)
    .map((l) =>
      l
        .replace(/https?:\/\/\S+/g, "[url]")
        .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[secret]")
        .replace(/\*{6,}/g, "[code]")
        .replace(/(Paste code here if prompted >)\s*\S+$/, "$1 [code]"),
    )
    .join(" / ")
}

/** Throwaway CLAUDE_CONFIG_DIR of one sign-in (tmpfs; removed however the scratch ends). */
export function loginDir(scratch: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(scratch)) throw new Error("invalid scratch name")
  return `/dev/shm/teros-auth-${scratch}`
}

/**
 * Shell line run in the private scratch session: install on first use (into
 * the workspace's $HOME, where every session finds `claude`), then `claude
 * auth login` with its own CLAUDE_CONFIG_DIR, so nothing of the account lands
 * in the $HOME every member of the workspace shares. The backend reads the
 * credential and account out of that dir when the login exits 0, before it
 * ends the scratch session. The CLI survives the SIGHUP of kill-session when
 * it sits in the foreground, and bash holds a trap until a foreground child
 * ends, so the CLI and the final pause both run as children the shell waits
 * on: the HUP trap ends the shell at once, and the EXIT trap kills them and
 * removes the dir.
 */
export function claudeLoginCommand(dir: string): string {
  return [
    'export PATH="$HOME/.local/bin:$PATH"',
    "L=/tmp/teros-claude-install.log",
    "if ! command -v claude >/dev/null; then echo TEROS_INSTALLING; { curl -fsSL https://claude.ai/install.sh -o /tmp/teros-claude-install.sh && bash /tmp/teros-claude-install.sh; } >$L 2>&1; command -v claude >/dev/null || { echo TEROS_INSTALL_FAILED; tail -n 3 $L; sleep 600; exit 1; }; echo TEROS_INSTALLED; fi",
    `T=${dir}`,
    'rm -rf "$T"; mkdir -m 700 -p "$T"',
    `trap 'kill $C $S 2>/dev/null; rm -rf "$T"' EXIT`,
    "trap 'exit 129' HUP TERM",
    // A non-interactive shell gives background jobs /dev/null as stdin: hand it the pane.
    'CLAUDE_CONFIG_DIR="$T" claude auth login --claudeai </dev/tty & C=$!',
    "wait $C",
    'echo "TEROS_LOGIN_EXITED $?"',
    // Waited on, not in the foreground: bash would hold the HUP trap (and the dir) until it ends.
    "sleep 600 & S=$!",
    "wait $S",
  ].join("; ")
}

export type SetupScreen =
  | { kind: "url"; url: string }
  | { kind: "installing" | "installed" | "waiting" }
  | { kind: "failed"; code: "INSTALL_FAILED" | "LOGIN_UNAVAILABLE"; message: string }

/** Where the scratch session running claudeLoginCommand is, from its screen. */
export function readSetupScreen(lines: string[], width: number): SetupScreen {
  if (lines.some((l) => l.includes("TEROS_INSTALL_FAILED"))) {
    return {
      kind: "failed",
      code: "INSTALL_FAILED",
      message: `Claude Code could not be installed in this workspace: ${redactScreen(
        lines.filter((l) => !l.startsWith("TEROS_")),
        3,
      )}`,
    }
  }
  const exited = lines.find((l) => l.startsWith("TEROS_LOGIN_EXITED"))
  if (exited) {
    const status = exited.slice("TEROS_LOGIN_EXITED ".length) || "?"
    return {
      kind: "failed",
      code: "LOGIN_UNAVAILABLE",
      message: `claude auth login stopped (exit ${status}) before offering a sign-in link: ${redactScreen(lines.filter((l) => !l.startsWith("TEROS_")))}`,
    }
  }
  const url = extractLoginUrl(lines, width)
  if (url) return { kind: "url", url }
  if (lines.some((l) => l.includes("TEROS_INSTALLED"))) return { kind: "installed" }
  if (lines.some((l) => l.includes("TEROS_INSTALLING"))) return { kind: "installing" }
  return { kind: "waiting" }
}

/** The code sits masked in the CLI's field, not yet submitted. */
export function codeInField(lines: string[]): boolean {
  return lines.some((l) => /Paste code here if prompted >\s*\*+/.test(l))
}

/** After the code went in: login done, the CLI's error, or nothing yet. */
export function readExchangeScreen(
  lines: string[],
): { kind: "done" } | { kind: "error"; error: string } | null {
  const error = extractLoginError(lines)
  if (error) return { kind: "error", error }
  const exited = lines.find((l) => l.startsWith("TEROS_LOGIN_EXITED"))
  if (!exited) return null
  const status = exited.slice("TEROS_LOGIN_EXITED ".length).trim()
  return status === "0"
    ? { kind: "done" }
    : { kind: "error", error: `claude auth login exited with ${status || "?"}` }
}

/** Prints (to the backend, over docker exec) what a finished login left in its dir. */
export function harvestLoginScript(dir: string): string {
  return [
    "node - <<'TEROS_EOF'",
    "const fs = require('fs')",
    `const dir = ${JSON.stringify(dir)}`,
    "const read = (f) => { try { return JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8')) } catch { return null } }",
    "let files = []",
    "try { files = fs.readdirSync(dir) } catch {}",
    "process.stdout.write(JSON.stringify({ files, claudeAiOauth: read('.credentials.json')?.claudeAiOauth ?? null, oauthAccount: read('.claude.json')?.oauthAccount ?? null }))",
    "TEROS_EOF",
  ].join("\n")
}

/** A login's harvest, checked: both halves present, or why not (names only). */
export function parseHarvest(
  stdout: string,
): { ok: true; account: ClaudeAccount } | { ok: false; reason: string } {
  let out: { files?: string[]; claudeAiOauth?: ClaudeOauth | null; oauthAccount?: unknown } = {}
  try {
    out = JSON.parse(stdout)
  } catch {
    return { ok: false, reason: "the sign-in left nothing readable" }
  }
  const files = (out.files ?? []).join(", ") || "nothing"
  const cred = out.claudeAiOauth
  if (!cred || typeof cred.accessToken !== "string" || typeof cred.expiresAt !== "number")
    return { ok: false, reason: `no Claude credential after the sign-in (found: ${files})` }
  if (!out.oauthAccount || typeof out.oauthAccount !== "object")
    return { ok: false, reason: `no account record after the sign-in (found: ${files})` }
  return {
    ok: true,
    account: {
      claudeAiOauth: cred,
      oauthAccount: out.oauthAccount as ClaudeAccount["oauthAccount"],
    },
  }
}

/** Entries of a private config dir that are the person's own; everything else links to ~/.claude. */
const PRIVATE_ENTRIES = [
  ".credentials.json",
  ".claude.json",
  "backups",
  "remote-settings.json",
  "remote-settings.json.synced-at",
  "policy-limits.json",
  "policy-limits.json.signature.json",
  "policy-limits.json.stamp.json",
]
/** Shared dirs created up front so Claude Code never fills the tmpfs with them. */
const SHARED_DIRS = [
  "projects",
  "todos",
  "shell-snapshots",
  "file-history",
  "debug",
  "statsig",
  "plugins",
  "cache",
  "sessions",
  "session-env",
  "downloads",
  "agents",
  "commands",
  "skills",
  "ide",
  "paste-cache",
]

/**
 * Builds (or refreshes) the person's private CLAUDE_CONFIG_DIR on the host:
 *  - .credentials.json — written only when the stored credential is strictly
 *    newer than the dir's (Claude Code may have refreshed it in there);
 *  - .claude.json — on first use a copy of the shared ~/.claude.json without
 *    anyone's account or API-key approvals, then their oauthAccount,
 *    onboarding done and trust for the session's /workspace directory;
 *  - every other entry is a symlink into the shared ~/.claude (settings with
 *    Teros' hooks, plugins, projects, history), as for any session.
 * Runs via `bash -s` (stdin), so the credential is never in argv. Prints the
 * dir's credential as it was, for the backend's dir→store sync.
 */
export function materializeClaudeDirScript(
  dir: string,
  account: ClaudeAccount,
  cwd: string,
): string {
  const trust = cwd === "/workspace" || cwd.startsWith("/workspace/") ? cwd : ""
  return [
    "node - <<'TEROS_EOF'",
    "const fs = require('fs')",
    `const dir = ${JSON.stringify(dir)}`,
    `const account = ${JSON.stringify(account)}`,
    `const trust = ${JSON.stringify(trust)}`,
    `const PRIVATE = new Set(${JSON.stringify(PRIVATE_ENTRIES)})`,
    `const SHARED_DIRS = ${JSON.stringify(SHARED_DIRS)}`,
    "const home = process.env.HOME, shared = home + '/.claude'",
    "const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }",
    "const writeJson = (f, v) => { fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 2), { mode: 0o600 }); fs.renameSync(f + '.tmp', f) }",
    "fs.mkdirSync(require('path').dirname(dir), { recursive: true, mode: 0o700 })",
    "fs.mkdirSync(dir, { recursive: true, mode: 0o700 })",
    "fs.chmodSync(dir, 0o700)",
    "for (const d of SHARED_DIRS) fs.mkdirSync(shared + '/' + d, { recursive: true })",
    "for (const name of fs.readdirSync(shared)) {",
    "  if (PRIVATE.has(name)) continue",
    "  try { fs.lstatSync(dir + '/' + name) } catch { fs.symlinkSync(shared + '/' + name, dir + '/' + name) }",
    "}",
    "const inDir = readJson(dir + '/.credentials.json')?.claudeAiOauth ?? null",
    "const stored = account.claudeAiOauth",
    "const wrote = !inDir || (stored.expiresAt || 0) > (inDir.expiresAt || 0)",
    "if (wrote) writeJson(dir + '/.credentials.json', { claudeAiOauth: stored })",
    "let cfg = readJson(dir + '/.claude.json')",
    "if (!cfg || typeof cfg !== 'object') {",
    "  cfg = readJson(home + '/.claude.json') || {}",
    "  delete cfg.oauthAccount; delete cfg.primaryApiKey; delete cfg.customApiKeyResponses",
    "}",
    "cfg.oauthAccount = account.oauthAccount",
    "cfg.hasCompletedOnboarding = true",
    "if (!cfg.theme) cfg.theme = 'dark'",
    "if (trust) {",
    "  cfg.projects = cfg.projects && typeof cfg.projects === 'object' ? cfg.projects : {}",
    "  cfg.projects[trust] = { ...(cfg.projects[trust] || {}), hasTrustDialogAccepted: true }",
    "}",
    "writeJson(dir + '/.claude.json', cfg)",
    "process.stdout.write(JSON.stringify({ inDir, wrote }))",
    "TEROS_EOF",
  ].join("\n")
}

/** Prints the credential in a person's config dir (for the periodic dir→store sync). */
export function readClaudeDirScript(dir: string): string {
  return [
    "node - <<'TEROS_EOF'",
    "const fs = require('fs')",
    `const dir = ${JSON.stringify(dir)}`,
    "let inDir = null",
    "try { inDir = JSON.parse(fs.readFileSync(dir + '/.credentials.json', 'utf8')).claudeAiOauth ?? null } catch {}",
    "process.stdout.write(JSON.stringify({ inDir }))",
    "TEROS_EOF",
  ].join("\n")
}

/** Removes a person's config dir (sign out, or another sign-in method chosen). */
export function removeClaudeDirScript(dir: string): string {
  if (!dir.startsWith("/dev/shm/teros-claude/")) throw new Error("not a Teros Claude dir")
  return `rm -rf ${JSON.stringify(dir)}`
}

/**
 * Prepares ~/.claude.json so a session started with injected credentials
 * opens straight at the prompt: Claude Code otherwise runs its first-run
 * onboarding (theme, "Select login method" even with CLAUDE_CODE_OAUTH_TOKEN
 * set, security notes) and the folder trust dialog, whose default answer is
 * "No, exit". Trust is granted only to the session's directory under
 * /workspace (the workspace's own volume). Never touches credentials.
 */
export function claudeSessionPrepScript(cwd: string): string {
  const trust = cwd === "/workspace" || cwd.startsWith("/workspace/") ? cwd : ""
  return [
    "node - <<'TEROS_EOF'",
    "const fs = require('fs')",
    "const path = process.env.HOME + '/.claude.json'",
    "let cfg = {}",
    "try { cfg = JSON.parse(fs.readFileSync(path, 'utf8')) } catch {}",
    "cfg.hasCompletedOnboarding = true",
    "if (!cfg.theme) cfg.theme = 'dark'",
    `const trust = ${JSON.stringify(trust)}`,
    "if (trust) {",
    "  cfg.projects = cfg.projects || {}",
    "  cfg.projects[trust] = { ...(cfg.projects[trust] || {}), hasTrustDialogAccepted: true }",
    "}",
    "fs.writeFileSync(path, JSON.stringify(cfg, null, 2))",
    "TEROS_EOF",
  ].join("\n")
}
