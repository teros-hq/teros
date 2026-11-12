/**
 * Coding-agent credentials in Terminal sessions: per user, never per
 * workspace. Pure helpers (login URL parsing, screens of `claude auth login`,
 * harvest of its result, the private config dir, env mapping, key hints,
 * login-screen detection) and the WS domain rules: no bridge access, write
 * access required, key validation, injection into the person's own sessions,
 * and into a Teros agent's session only when shared with that workspace.
 */

import { describe, expect, it, mock } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { WsHandlerContext } from "@teros/shared"
import { register } from "../../src/handlers/domains/terminal/index"
import {
  accountLabel,
  type ClaudeAccount,
  claudeConfigDir,
  claudeLoginCommand,
  claudeSessionPrepScript,
  codeInField,
  envForSecret,
  extractLoginError,
  extractLoginUrl,
  fresherCredential,
  keyHint,
  loginDir,
  loginErrorMessage,
  materializeClaudeDirScript,
  parseHarvest,
  readExchangeScreen,
  readSetupScreen,
  redactScreen,
  removeClaudeDirScript,
} from "../../src/services/terminal/agent-credentials"
import { detectLoginScreen } from "../../src/services/terminal/agent-heuristics"
import { claudeApproveKeyScript } from "../../src/services/terminal/agent-hooks"

const FAKE_KEY = "sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKE-test-0000abcd"
/** Shaped like Claude Code's tokens; not credentials. */
const FAKE_TOKEN = `sk-ant-oat01-${"FAKE_fake-0123456789".repeat(4)}${"x".repeat(13)}-AA`
const FAKE_REFRESH = `sk-ant-ort01-${"FAKE_refresh-0123456".repeat(4)}-AA`
const FAKE_ACCOUNT: ClaudeAccount = {
  claudeAiOauth: {
    accessToken: FAKE_TOKEN,
    refreshToken: FAKE_REFRESH,
    expiresAt: 2_000_000_000_000,
    scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
    subscriptionType: "max",
  },
  oauthAccount: {
    accountUuid: "00000000-0000-0000-0000-000000000001",
    emailAddress: "fake.person@example.com",
    organizationName: "Fake Org",
  },
}
const AUTH_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload+user%3Aplugins&code_challenge=FAKECHALLENGEFAKECHALLENGEFAKE0000&code_challenge_method=S256&state=FAKESTATEFAKESTATEFAKESTATE00000"

/** `claude auth login`'s screen while it waits for the code (v2.1.304; URL hard-wrapped at `width`). */
function setupScreen(width: number, field = ""): string[] {
  const line = `If the browser didn't open, visit: ${AUTH_URL}`
  return [
    "Opening browser to sign in…",
    ...(line.match(new RegExp(`.{1,${width}}`, "g")) ?? []),
    `Paste code here if prompted >${field ? ` ${field}` : ""}`,
  ]
}

describe("agent credential helpers", () => {
  it("reassembles the hard-wrapped authorize URL the CLI prints", () => {
    const w = 120
    const url =
      "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=KIB1gO0&state=1dq1a"
    const wrapped = url.match(/.{1,120}/g) ?? []
    const lines = [
      " Browser didn't open? Use the url below to sign in (c to copy)",
      ...wrapped,
      " Hold Shift while selecting",
      " Paste code here if prompted >",
    ]
    expect(wrapped[0].length).toBe(w)
    expect(extractLoginUrl(lines, w)).toBe(url)
    expect(extractLoginUrl(["nothing here"], w)).toBeNull()
  })

  it("reads claude auth login's outcome: done on exit 0, its own error line otherwise", () => {
    // v2.1.304 prints the error on the prompt's own line, then exits 1.
    const rejected = [
      "Paste code here if prompted > Login failed: Request failed with status code 400",
      "TEROS_LOGIN_EXITED 1",
    ]
    expect(readExchangeScreen(rejected)).toEqual({
      kind: "error",
      error: "Login failed: Request failed with status code 400",
    })
    expect(readExchangeScreen(["Login successful.", "TEROS_LOGIN_EXITED 0"])).toEqual({
      kind: "done",
    })
    expect(readExchangeScreen(["TEROS_LOGIN_EXITED 2"])).toEqual({
      kind: "error",
      error: "claude auth login exited with 2",
    })
    expect(readExchangeScreen(setupScreen(200))).toBeNull()
  })

  it("takes a finished login's account only when both halves are there", () => {
    const ok = parseHarvest(
      JSON.stringify({
        files: [".claude.json", ".credentials.json", "backups"],
        claudeAiOauth: FAKE_ACCOUNT.claudeAiOauth,
        oauthAccount: FAKE_ACCOUNT.oauthAccount,
      }),
    )
    expect(ok).toEqual({ ok: true, account: FAKE_ACCOUNT })
    const noCred = parseHarvest(
      JSON.stringify({ files: [".claude.json"], claudeAiOauth: null, oauthAccount: {} }),
    )
    expect(noCred).toEqual({
      ok: false,
      reason: "no Claude credential after the sign-in (found: .claude.json)",
    })
    const noAccount = parseHarvest(
      JSON.stringify({
        files: [".credentials.json"],
        claudeAiOauth: FAKE_ACCOUNT.claudeAiOauth,
        oauthAccount: null,
      }),
    )
    expect(noAccount).toMatchObject({
      ok: false,
      reason: expect.stringContaining("no account record"),
    })
    expect(JSON.stringify(noAccount)).not.toContain(FAKE_TOKEN)
    expect(parseHarvest("not json")).toMatchObject({ ok: false })
  })

  it("labels the account and keeps whichever credential copy is newer", () => {
    expect(accountLabel(FAKE_ACCOUNT)).toBe("fake.person@example.com (Max)")
    expect(
      accountLabel({
        ...FAKE_ACCOUNT,
        claudeAiOauth: { ...FAKE_ACCOUNT.claudeAiOauth, subscriptionType: "pro" },
      }),
    ).toBe("fake.person@example.com (Pro)")
    expect(accountLabel({ ...FAKE_ACCOUNT, oauthAccount: {} })).toBe("Claude Max")
    const stored = FAKE_ACCOUNT.claudeAiOauth
    expect(fresherCredential(stored, null)).toBe("stored")
    expect(fresherCredential(stored, { ...stored })).toBe("same")
    expect(
      fresherCredential(stored, { ...stored, accessToken: "x", expiresAt: stored.expiresAt + 1 }),
    ).toBe("dir")
    expect(
      fresherCredential(stored, { ...stored, accessToken: "x", expiresAt: stored.expiresAt - 1 }),
    ).toBe("stored")
    // One dir per person, on the host's tmpfs, named by a hash (no user id in paths).
    expect(claudeConfigDir("user_1")).toMatch(/^\/dev\/shm\/teros-claude\/[0-9a-f]{16}$/)
    expect(claudeConfigDir("user_1")).not.toBe(claudeConfigDir("user_2"))
    expect(claudeConfigDir("user_1")).not.toContain("user_1")
    expect(() => removeClaudeDirScript("/workspace")).toThrow()
  })

  it("names the CLI's failures and turns them into something a person can act on", () => {
    const screen = [" OAuth error: Request failed with status code 400", " Press Enter to retry."]
    expect(extractLoginError(screen)).toBe("OAuth error: Request failed with status code 400")
    expect(extractLoginError([" Press Enter to retry."])).toBe("Press Enter to retry.")
    expect(
      extractLoginError([
        "Paste code here if prompted > Login failed: Request failed with status code 400",
      ]),
    ).toBe("Login failed: Request failed with status code 400")
    // Ordinary words like "failed" elsewhere on the screen are not a sign-in error.
    expect(extractLoginError(["⚠ Remote managed settings failed to load"])).toBeNull()
    expect(loginErrorMessage("OAuth error: Request failed with status code 400")).toContain(
      "Codes work once and expire",
    )
    expect(loginErrorMessage("OAuth error: Request failed with status code 403")).toContain(
      "Pro or Max",
    )
    expect(loginErrorMessage("OAuth error: getaddrinfo ENOTFOUND")).toContain(
      "could not be reached",
    )
  })

  it("follows the scratch session: install, install failure, early exit, sign-in link", () => {
    expect(readSetupScreen([], 200)).toEqual({ kind: "waiting" })
    expect(readSetupScreen(["TEROS_INSTALLING"], 200)).toEqual({ kind: "installing" })
    expect(readSetupScreen(["TEROS_INSTALLING", "TEROS_INSTALLED"], 200)).toEqual({
      kind: "installed",
    })
    const failed = readSetupScreen(
      ["TEROS_INSTALLING", "TEROS_INSTALL_FAILED", "curl: (6) Could not resolve host: claude.ai"],
      200,
    )
    expect(failed).toMatchObject({ kind: "failed", code: "INSTALL_FAILED" })
    expect((failed as any).message).toContain("Could not resolve host")
    expect(
      readSetupScreen(["bash: claude: command not found", "TEROS_LOGIN_EXITED 127"], 200),
    ).toMatchObject({
      kind: "failed",
      code: "LOGIN_UNAVAILABLE",
      message: expect.stringContaining("exit 127"),
    })
    expect(readSetupScreen(setupScreen(200), 200)).toEqual({ kind: "url", url: AUTH_URL })
    const command = claudeLoginCommand(loginDir("auth-abc"))
    expect(command).toContain("TEROS_INSTALL_FAILED")
    // The login never touches the workspace's shared $HOME: its own config dir, on tmpfs, removed on exit.
    const install = command.indexOf("install.sh")
    const dir = command.indexOf("T=/dev/shm/teros-auth-auth-abc")
    expect(install).toBeGreaterThan(-1)
    expect(dir).toBeGreaterThan(install)
    expect(command).toContain(`trap 'kill $C $S 2>/dev/null; rm -rf "$T"' EXIT`)
    expect(command).toMatch(/sleep 600 & S=\$!; wait \$S$/)
    expect(command).toContain("trap 'exit 129' HUP TERM")
    expect(command).toContain(
      'CLAUDE_CONFIG_DIR="$T" claude auth login --claudeai </dev/tty & C=$!; wait $C',
    )
    expect(() => loginDir("a b; rm -rf /")).toThrow()
  })

  it("builds the private config dir: own account only, shared settings linked, newest credential wins", () => {
    const root = mkdtempSync(join(tmpdir(), "tglogin-"))
    try {
      const home = join(root, "home")
      const dir = join(root, "shm", "teros-claude", "abc")
      mkdirSync(join(home, ".claude", "plugins"), { recursive: true })
      writeFileSync(join(home, ".claude", "settings.json"), '{"hooks":{}}')
      // The shared config carries someone else's account and API-key approval.
      writeFileSync(
        join(home, ".claude.json"),
        JSON.stringify({
          oauthAccount: { emailAddress: "someone.else@example.com" },
          primaryApiKey: "sk-ant-api03-SOMEONEELSE",
          customApiKeyResponses: { approved: ["SOMEONEELSE"] },
          mcpServers: { shared: {} },
        }),
      )
      const run = (account: ClaudeAccount) => {
        const out = spawnSync("bash", ["-s"], {
          input: materializeClaudeDirScript(dir, account, "/workspace/app"),
          env: { ...process.env, HOME: home },
          encoding: "utf8",
        })
        expect(out.status).toBe(0)
        return JSON.parse(out.stdout) as { inDir: unknown; wrote: boolean }
      }
      expect(run(FAKE_ACCOUNT)).toEqual({ inDir: null, wrote: true })
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      expect(statSync(join(dir, ".credentials.json")).mode & 0o777).toBe(0o600)
      const cfg = JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8"))
      expect(cfg.oauthAccount).toEqual(FAKE_ACCOUNT.oauthAccount)
      expect(cfg.primaryApiKey).toBeUndefined()
      expect(cfg.customApiKeyResponses).toBeUndefined()
      expect(cfg.mcpServers).toEqual({ shared: {} })
      expect(cfg.hasCompletedOnboarding).toBe(true)
      expect(cfg.projects["/workspace/app"].hasTrustDialogAccepted).toBe(true)
      // Teros' hooks and the big shared dirs are links, never copies on the tmpfs.
      for (const name of ["settings.json", "plugins", "projects", "cache"]) {
        expect(lstatSync(join(dir, name)).isSymbolicLink()).toBe(true)
        expect(readlinkSync(join(dir, name))).toBe(join(home, ".claude", name))
      }
      // The shared config is untouched.
      expect(
        JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).oauthAccount.emailAddress,
      ).toBe("someone.else@example.com")
      // Claude Code refreshed the token in the dir: an older stored copy never overwrites it.
      const refreshed = {
        ...FAKE_ACCOUNT.claudeAiOauth,
        accessToken: "sk-ant-oat01-REFRESHED",
        expiresAt: 2_000_000_100_000,
      }
      writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: refreshed }))
      expect(run(FAKE_ACCOUNT)).toEqual({ inDir: refreshed, wrote: false })
      expect(
        JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf8")).claudeAiOauth,
      ).toEqual(refreshed)
      // A newer stored copy (refreshed in another workspace) replaces the dir's.
      const newer = {
        ...FAKE_ACCOUNT,
        claudeAiOauth: {
          ...refreshed,
          accessToken: "sk-ant-oat01-NEWER",
          expiresAt: 2_000_000_200_000,
        },
      }
      expect(run(newer).wrote).toBe(true)
      expect(
        JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf8")).claudeAiOauth.accessToken,
      ).toBe("sk-ant-oat01-NEWER")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("redacts URLs, tokens and the code from anything it reports", () => {
    const text = redactScreen([
      AUTH_URL,
      ` ${FAKE_TOKEN}`,
      " Paste code here if prompted > ********************",
    ])
    expect(redactScreen(["Paste code here if prompted > FAKEcode#FAKEstate"])).not.toContain(
      "FAKEcode",
    )
    expect(text).not.toContain("oauth/authorize")
    expect(text).not.toContain("FAKE")
    expect(text).not.toContain("*****")
    expect(codeInField([" Paste code here if prompted > ****"])).toBe(true)
    expect(codeInField([" Paste code here if prompted >"])).toBe(false)
  })

  it("session prep skips onboarding, trusts only /workspace dirs and carries no secret", () => {
    const script = claudeSessionPrepScript("/workspace/app")
    expect(script).toContain("cfg.hasCompletedOnboarding = true")
    expect(script).toContain('const trust = "/workspace/app"')
    expect(script).toContain("hasTrustDialogAccepted: true")
    expect(script).not.toContain("sk-ant-")
    expect(claudeSessionPrepScript("/etc")).toContain('const trust = ""')
    expect(claudeSessionPrepScript("/workspacex")).toContain('const trust = ""')
  })

  it("maps modes to the env each agent reads; hints show four characters only", () => {
    expect(envForSecret("claude", "apiKey", "k")).toEqual({ ANTHROPIC_API_KEY: "k" })
    expect(envForSecret("claude", "subscription", "t")).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "t" })
    expect(envForSecret("codex", "apiKey", "sk-x")).toEqual({ OPENAI_API_KEY: "sk-x" })
    expect(envForSecret("opencode", "apiKey", "sk-ant-x")).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-x",
    })
    expect(keyHint(FAKE_KEY)).toBe("····abcd")
  })

  it("the key pre-approval script carries only the last 20 characters", () => {
    const script = claudeApproveKeyScript(FAKE_KEY)
    expect(script).toContain(JSON.stringify(FAKE_KEY.slice(-20)))
    expect(script).not.toContain(FAKE_KEY.slice(0, 30))
  })

  it("detects Claude Code's login screen", () => {
    expect(
      detectLoginScreen([" Select login method:", " ❯ 1. Claude account with subscription"]),
    ).toBe(true)
    expect(detectLoginScreen(["Not logged in · Run /login"])).toBe(true)
    expect(detectLoginScreen(["❯ fix the failing tests", "? for shortcuts"])).toBe(false)
  })
})

// ── WS domain ────────────────────────────────────────────────────────────────

const ctx = (userId: string): WsHandlerContext =>
  ({ userId, sessionId: "sess1", connectionId: "c1" }) as any
const bridgeCtx = (userId: string): WsHandlerContext =>
  ({ userId, sessionId: "mca:app_terminal", ip: "mca:mca.teros.terminal" }) as any

function makeDb(members: Record<string, "read" | "write">) {
  return {
    collection: (name: string) => ({
      findOne: async (filter: any) => {
        if (name === "workspaces")
          return { workspaceId: filter.workspaceId, ownerId: "owner", status: "active" }
        if (name === "workspace_members") {
          const role = members[filter.userId]
          return role ? { workspaceId: filter.workspaceId, userId: filter.userId, role } : null
        }
        return null
      },
    }),
  } as any
}

/** In-memory AgentCredentialStore with the same contract (no crypto). */
function makeStore() {
  const docs = new Map<
    string,
    { mode: string; secret?: string; account?: ClaudeAccount; label: string; shared: string[] }
  >()
  const k = (u: string, a: string) => `${u}/${a}`
  const synced: { userId: string; inDir: unknown }[] = []
  const status = (u: string, a: string, ws?: string) => {
    const d = docs.get(k(u, a))
    return {
      agent: a,
      mode: d?.mode ?? null,
      label: d?.label ?? null,
      teros: { available: false },
      shared: ws ? (d?.shared ?? []).includes(ws) : false,
    }
  }
  return {
    docs,
    synced,
    status: async (u: string, a: string, ws?: string) => status(u, a, ws),
    useTeros: async () => {
      throw new Error("No Teros provider can serve this agent")
    },
    setSecret: async (u: string, a: string, mode: string, secret: string, label: string) => {
      docs.set(k(u, a), { mode, secret, label, shared: docs.get(k(u, a))?.shared ?? [] })
    },
    setAccount: async (u: string, account: ClaudeAccount) => {
      const label = accountLabel(account)
      docs.set(k(u, "claude"), {
        mode: "subscription",
        account,
        label,
        shared: docs.get(k(u, "claude"))?.shared ?? [],
      })
      return label
    },
    syncAccountCredential: async (u: string, inDir: unknown) => {
      synced.push({ userId: u, inDir })
      return "same"
    },
    setShared: async (u: string, a: string, ws: string, on: boolean) => {
      const d = docs.get(k(u, a))
      if (d) d.shared = on ? [...new Set([...d.shared, ws])] : d.shared.filter((x) => x !== ws)
    },
    clear: async (u: string, a: string) => {
      docs.delete(k(u, a))
    },
    env: async (u: string, a: string, opts: { forWorkspace?: string } = {}) => {
      const d = docs.get(k(u, a))
      if (!d?.secret && !d?.account) return null
      if (opts.forWorkspace && !d.shared.includes(opts.forWorkspace)) return null
      if (d.account) {
        const dir = claudeConfigDir(u)
        return {
          env: { CLAUDE_CONFIG_DIR: dir },
          label: d.label,
          mode: d.mode,
          claude: { dir, account: d.account },
        }
      }
      return {
        env: envForSecret(a as any, d.mode as any, d.secret as string),
        label: d.label,
        mode: d.mode,
      }
    },
  }
}

type Scenario = "ok" | "swallowFirstEnter" | "badCode" | "installFails" | "noLink" | "noAccount"

/**
 * A scratch session that behaves like `claude auth login` on v2.1.304: the
 * URL screen, the code field, and Enter handling. An Enter that arrives
 * within 50 ms of the code is lost, as Claude Code's input does with a burst
 * it takes for a paste; `swallowFirstEnter` loses the first Enter whatever
 * its timing.
 */
function makeScratch(scenario: Scenario) {
  const typed: string[] = []
  const typedAt: number[] = []
  const killed: string[] = []
  const started: { name: string; command: string; cols?: number }[] = []
  let screen: string[] = []
  let field = ""
  let enters = 0
  const api = {
    typed,
    typedAt,
    killed,
    started,
    startScratch: async (name: string, command: string, _env: unknown, cols?: number) => {
      started.push({ name, command, cols })
      screen =
        scenario === "installFails"
          ? [
              "TEROS_INSTALLING",
              "TEROS_INSTALL_FAILED",
              "curl: (6) Could not resolve host: claude.ai",
            ]
          : scenario === "noLink"
            ? ["Welcome to Claude Code"]
            : setupScreen(200)
    },
    scratchLines: async () => screen,
    scratchType: async (_name: string, text: string) => {
      const glued = typedAt.length > 0 && Date.now() - typedAt[typedAt.length - 1] < 50
      typed.push(text)
      typedAt.push(Date.now())
      if (text !== "\r") {
        field += "*".repeat(text.length)
        screen = setupScreen(200, field)
        return
      }
      enters++
      if (glued || (scenario === "swallowFirstEnter" && enters === 1)) return
      if (scenario === "badCode") {
        screen = [
          ...setupScreen(200).slice(0, -1),
          "Paste code here if prompted > Login failed: Request failed with status code 400",
          "TEROS_LOGIN_EXITED 1",
        ]
        return
      }
      screen = [...setupScreen(200), "Login successful.", "TEROS_LOGIN_EXITED 0"]
    },
    killScratch: async (name: string) => {
      killed.push(name)
    },
    /** What the finished login left in its dir, as harvestLoginScript prints it. */
    harvest: () =>
      JSON.stringify({
        files: [".claude.json", ".credentials.json"],
        claudeAiOauth: FAKE_ACCOUNT.claudeAiOauth,
        oauthAccount: scenario === "noAccount" ? null : FAKE_ACCOUNT.oauthAccount,
      }),
  }
  return api
}

/** Poll terminal.agentAuthLoginState until the sign-in reaches one of `phases`. */
async function waitPhase(
  handlers: Map<string, (ctx: WsHandlerContext, data: unknown) => Promise<any>>,
  userId: string,
  loginId: string,
  phases: string[],
  ms = 8000,
) {
  const deadline = Date.now() + ms
  for (;;) {
    const view = await handlers.get("terminal.agentAuthLoginState")!(ctx(userId), { loginId })
    if (phases.includes(view.phase)) return view
    if (Date.now() > deadline) throw new Error(`still ${view.phase}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

function setup(
  members: Record<string, "read" | "write"> = { writer: "write", reader: "read" },
  scenario: Scenario = "ok",
) {
  const handlers = new Map<string, (ctx: WsHandlerContext, data: unknown) => Promise<any>>()
  const router = { register: (a: string, h: any) => handlers.set(a, h) } as any
  const store = makeStore()
  const scripts: string[] = []
  const created: any[] = []
  const scratch = makeScratch(scenario)
  const host = {
    appId: "app_bash",
    container: "teros-term-x",
    workspaceId: "work_1",
    runScript: async (s: string) => {
      scripts.push(s)
      const stdout = s.includes("JSON.stringify({ files")
        ? scratch.harvest()
        : s.includes("const account =")
          ? JSON.stringify({ inDir: null, wrote: true })
          : ""
      return { code: 0, stdout, stderr: "" }
    },
    ...scratch,
  }
  const ptyManager = {
    has: () => false,
    whenAdopted: async () => {},
    termHostManager: { running: async () => host },
    createInHost: async (
      _h: any,
      id: string,
      _c: number,
      _r: number,
      _ws: string,
      meta: any,
      opts: any,
    ) => {
      created.push({ id, meta, opts })
    },
    write: mock(() => 1),
    onChange: () => {},
    describe: () => null,
    list: () => [],
  } as any
  register(router, {
    pubSubService: {
      subscribeSession: mock(() => {}),
      unsubscribeSession: mock(() => {}),
      broadcastToTopic: mock(() => {}),
    } as any,
    ptyManager,
    mcaService: {
      getApp: async () => ({ appId: "app_bash", ownerId: "work_1", mcaId: "mca.teros.bash" }),
    } as any,
    mcaManager: { executeTool: mock(async () => ({})) } as any,
    db: makeDb(members),
    exec: () => "",
    agentCredentials: store as any,
  })
  return { handlers, store, scripts, created, scratch }
}

describe("terminal.agentAuth* — credentials belong to a person", () => {
  it("API key: validated, stored for the caller only, status never returns it", async () => {
    const { handlers, store } = setup()
    await expect(
      handlers.get("terminal.agentAuthSet")!(ctx("writer"), {
        agent: "claude",
        workspaceId: "work_1",
        mode: "apiKey",
        apiKey: "sk-not-anthropic-0000000000",
      }),
    ).rejects.toMatchObject({ code: "INVALID_API_KEY" })
    const st = await handlers.get("terminal.agentAuthSet")!(ctx("writer"), {
      agent: "claude",
      workspaceId: "work_1",
      mode: "apiKey",
      apiKey: FAKE_KEY,
    })
    expect(st).toMatchObject({ mode: "apiKey", label: "API key ····abcd", shared: false })
    expect(JSON.stringify(st)).not.toContain("FAKEFAKE")
    expect(store.docs.get("writer/claude")?.secret).toBe(FAKE_KEY)
    expect(
      await handlers.get("terminal.agentAuthStatus")!(ctx("someone"), {
        agent: "claude",
        workspaceId: "work_1",
      }).catch((e: any) => e.code),
    ).toBe("FORBIDDEN_WORKSPACE_ROLE")
  })

  it("never through the MCA bridge; read members are refused", async () => {
    const { handlers } = setup()
    for (const action of [
      "terminal.agentAuthStatus",
      "terminal.agentAuthSet",
      "terminal.agentAuthShare",
      "terminal.agentAuthSignOut",
      "terminal.agentAuthLoginStart",
      "terminal.agentAuthLoginState",
      "terminal.agentAuthLoginFinish",
      "terminal.agentAuthLoginCancel",
    ]) {
      await expect(
        handlers.get(action)!(bridgeCtx("owner"), { agent: "claude", workspaceId: "work_1" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" })
    }
    await expect(
      handlers.get("terminal.agentAuthStatus")!(ctx("reader"), {
        agent: "claude",
        workspaceId: "work_1",
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN_WORKSPACE_ROLE",
    })
  })

  it("a person's Claude Code session gets their key as env and an auth chip; the key pre-approval runs", async () => {
    const { handlers, created, scripts } = setup()
    await handlers.get("terminal.agentAuthSet")!(ctx("writer"), {
      agent: "claude",
      workspaceId: "work_1",
      mode: "apiKey",
      apiKey: FAKE_KEY,
    })
    await handlers.get("terminal.create")!(ctx("writer"), {
      terminalId: "t1",
      appId: "app_bash",
      preset: "claude",
      subscribe: false,
    })
    expect(created[0].opts.env).toEqual({ ANTHROPIC_API_KEY: FAKE_KEY })
    expect(created[0].meta).toMatchObject({
      kind: "claude",
      auth: "API key ····abcd",
      title: "Claude Code",
    })
    expect(scripts.some((s) => s.includes(JSON.stringify(FAKE_KEY.slice(-20))))).toBe(true)
  })

  it("someone else's session never gets them; a Teros agent's only when shared with that workspace", async () => {
    const { handlers, created } = setup({ writer: "write", other: "write", owner: "write" })
    await handlers.get("terminal.agentAuthSet")!(ctx("owner"), {
      agent: "claude",
      workspaceId: "work_1",
      mode: "apiKey",
      apiKey: FAKE_KEY,
    })
    await handlers.get("terminal.create")!(ctx("other"), {
      terminalId: "t1",
      appId: "app_bash",
      preset: "claude",
      subscribe: false,
    })
    expect(created[0].opts.env).toBeUndefined()
    // Bridge: ctx.userId is the workspace owner
    await handlers.get("terminal.create")!(bridgeCtx("owner"), {
      terminalId: "t2",
      appId: "app_bash",
      preset: "claude",
      subscribe: false,
    })
    expect(created[1].opts.env).toBeUndefined()
    await handlers.get("terminal.agentAuthShare")!(ctx("owner"), {
      agent: "claude",
      workspaceId: "work_1",
      shared: true,
    })
    await handlers.get("terminal.create")!(bridgeCtx("owner"), {
      terminalId: "t3",
      appId: "app_bash",
      preset: "claude",
      subscribe: false,
    })
    expect(created[2].opts.env).toEqual({ ANTHROPIC_API_KEY: FAKE_KEY })
    expect(created[2].meta.createdBy.startsWith("agent:")).toBe(true)
  })

  it("an agent's create and list say whether the person's sign-in reaches it — never the secret or its label", async () => {
    const { handlers } = setup({ owner: "write" })
    const agentCtx = {
      ...bridgeCtx("owner"),
      actor: { kind: "agent", agentId: "agent_1", workspaceId: "work_1", appId: "app_terminal" },
    } as any
    const create = (terminalId: string) =>
      handlers.get("terminal.create")!(agentCtx, {
        terminalId,
        appId: "app_bash",
        preset: "claude",
        subscribe: false,
      })
    const list = () => handlers.get("terminal.list")!(agentCtx, {})

    const none = { agent: "claude", signedIn: false, mode: null, shared: false }
    expect((await create("t1")).agentAuth).toEqual(none)
    expect((await list()).agentAuth).toEqual(none)

    await handlers.get("terminal.agentAuthSet")!(ctx("owner"), {
      agent: "claude",
      workspaceId: "work_1",
      mode: "apiKey",
      apiKey: FAKE_KEY,
    })
    expect((await list()).agentAuth).toEqual({ ...none, signedIn: true, mode: "apiKey" })

    await handlers.get("terminal.agentAuthShare")!(ctx("owner"), {
      agent: "claude",
      workspaceId: "work_1",
      shared: true,
    })
    const shared = { agent: "claude", signedIn: true, mode: "apiKey", shared: true }
    const created = await create("t2")
    expect(created.agentAuth).toEqual(shared)
    expect((await list()).agentAuth).toEqual(shared)
    expect(JSON.stringify(created)).not.toContain("FAKEFAKE")
    expect(JSON.stringify(created)).not.toContain("····")

    // The person's own window gets nothing extra, and a shell session neither.
    expect((await handlers.get("terminal.list")!(ctx("owner"), {})).agentAuth).toBeUndefined()
    const shell = await handlers.get("terminal.create")!(agentCtx, {
      terminalId: "t3",
      appId: "app_bash",
      subscribe: false,
    })
    expect(shell.agentAuth).toBeUndefined()
  })

  it("Use Teros without a capable provider is refused; sign out clears", async () => {
    const { handlers, store } = setup()
    await expect(
      handlers.get("terminal.agentAuthSet")!(ctx("writer"), {
        agent: "claude",
        workspaceId: "work_1",
        mode: "teros",
      }),
    ).rejects.toMatchObject({
      code: "TEROS_UNAVAILABLE",
    })
    await handlers.get("terminal.agentAuthSet")!(ctx("writer"), {
      agent: "claude",
      workspaceId: "work_1",
      mode: "apiKey",
      apiKey: FAKE_KEY,
    })
    const st = await handlers.get("terminal.agentAuthSignOut")!(ctx("writer"), {
      agent: "claude",
      workspaceId: "work_1",
    })
    expect(st.mode).toBeNull()
    expect(store.docs.size).toBe(0)
  })
})

describe("terminal.agentAuthLogin* — Sign in with Claude", () => {
  const start = (handlers: Map<string, any>, userId = "writer") =>
    handlers.get("terminal.agentAuthLoginStart")!(ctx(userId), {
      agent: "claude",
      workspaceId: "work_1",
      appId: "app_bash",
    })
  const signIn = async (handlers: Map<string, any>, userId = "writer") => {
    const { loginId } = await start(handlers, userId)
    await waitPhase(handlers, userId, loginId, ["ready"])
    await handlers.get("terminal.agentAuthLoginFinish")!(ctx(userId), { loginId, code: "OK" })
    return waitPhase(handlers, userId, loginId, ["done", "failed"])
  }
  const create = (handlers: Map<string, any>, c: WsHandlerContext, terminalId: string) =>
    handlers.get("terminal.create")!(c, {
      terminalId,
      appId: "app_bash",
      preset: "claude",
      subscribe: false,
    })

  it("start returns at once; the URL arrives by polling; the code and its Enter go in separately; the account is kept", async () => {
    const { handlers, store, scratch, scripts } = setup()
    const first = await start(handlers)
    expect(first.phase).toBe("starting")
    expect(first.url).toBeUndefined()
    const ready = await waitPhase(handlers, "writer", first.loginId, ["ready", "failed"])
    expect(ready).toMatchObject({ phase: "ready", url: AUTH_URL })
    expect(scratch.started[0].command).toBe(claudeLoginCommand(loginDir(scratch.started[0].name)))
    expect(scratch.started[0].cols).toBe(200)

    const pending = await handlers.get("terminal.agentAuthLoginFinish")!(ctx("writer"), {
      loginId: first.loginId,
      code: "FAKECODE123#FAKESTATE456",
    })
    expect(pending.phase).toBe("exchanging")
    const done = await waitPhase(handlers, "writer", first.loginId, ["done", "failed"])
    expect(done.phase).toBe("done")
    expect(done.status).toMatchObject({
      mode: "subscription",
      label: "fake.person@example.com (Max)",
    })
    expect(JSON.stringify(done)).not.toContain("sk-ant-")
    expect(scratch.typed).toEqual(["FAKECODE123#FAKESTATE456", "\r"])
    // Not one burst: Claude Code would take code + CR for a paste and drop the CR.
    expect(scratch.typedAt[1] - scratch.typedAt[0]).toBeGreaterThanOrEqual(200)
    expect(store.docs.get("writer/claude")).toMatchObject({
      mode: "subscription",
      account: FAKE_ACCOUNT,
    })
    // The account was read out of the login's own dir before the scratch session ended.
    expect(scripts.some((x) => x.includes(JSON.stringify(loginDir(scratch.started[0].name))))).toBe(
      true,
    )
    expect(scratch.killed).toContain(scratch.started[0].name)
  })

  it("an Enter swallowed with the paste is pressed again", async () => {
    const { handlers, store, scratch } = setup(undefined, "swallowFirstEnter")
    const { loginId } = await start(handlers)
    await waitPhase(handlers, "writer", loginId, ["ready"])
    const finish = handlers.get("terminal.agentAuthLoginFinish")!
    await finish(ctx("writer"), { loginId, code: "FAKECODE" })
    const done = await waitPhase(handlers, "writer", loginId, ["done", "failed"], 10_000)
    expect(done.phase).toBe("done")
    expect(store.docs.get("writer/claude")?.account).toEqual(FAKE_ACCOUNT)
    expect(scratch.typed).toEqual(["FAKECODE", "\r", "\r"])
  }, 15_000)

  it("a rejected code fails loudly with the reason and stores nothing", async () => {
    const { handlers, store } = setup(undefined, "badCode")
    const { loginId } = await start(handlers)
    await waitPhase(handlers, "writer", loginId, ["ready"])
    await handlers.get("terminal.agentAuthLoginFinish")!(ctx("writer"), { loginId, code: "BAD" })
    const failed = await waitPhase(handlers, "writer", loginId, ["done", "failed"])
    expect(failed.phase).toBe("failed")
    expect(failed.error.code).toBe("LOGIN_REJECTED")
    expect(failed.error.message).toContain("Codes work once and expire")
    expect(failed.error.message).toContain("Login failed: Request failed with status code 400")
    expect(store.docs.size).toBe(0)
    // The attempt is over: a second code is refused with the same reason.
    await expect(
      handlers.get("terminal.agentAuthLoginFinish")!(ctx("writer"), { loginId, code: "AGAIN" }),
    ).rejects.toMatchObject({ code: "LOGIN_NOT_READY" })
  })

  it("a login that leaves no account record is refused, not stored half", async () => {
    const { handlers, store } = setup(undefined, "noAccount")
    const failed = await signIn(handlers)
    expect(failed).toMatchObject({ phase: "failed", error: { code: "LOGIN_INCOMPLETE" } })
    expect(failed.error.message).toContain("no account record")
    expect(store.docs.size).toBe(0)
  })

  it("an install failure is named as such", async () => {
    const { handlers } = setup(undefined, "installFails")
    const { loginId } = await start(handlers)
    const failed = await waitPhase(handlers, "writer", loginId, ["failed", "ready"])
    expect(failed.error).toMatchObject({ code: "INSTALL_FAILED" })
    expect(failed.error.message).toContain("Could not resolve host")
  })

  it("someone else can't poll, finish or cancel your sign-in; a new start replaces the old", async () => {
    const { handlers, scratch } = setup({ writer: "write", other: "write" })
    const { loginId } = await start(handlers)
    await waitPhase(handlers, "writer", loginId, ["ready"])
    for (const action of [
      "terminal.agentAuthLoginState",
      "terminal.agentAuthLoginFinish",
      "terminal.agentAuthLoginCancel",
    ]) {
      await expect(
        handlers.get(action)!(ctx("other"), { loginId, code: "X" }),
      ).rejects.toMatchObject({ code: "LOGIN_NOT_FOUND" })
    }
    const second = await start(handlers)
    const replaced = await handlers.get("terminal.agentAuthLoginState")!(ctx("writer"), { loginId })
    expect(replaced).toMatchObject({ phase: "failed", error: { code: "LOGIN_REPLACED" } })
    expect(scratch.killed).toContain(scratch.started[0].name)
    await handlers.get("terminal.agentAuthLoginCancel")!(ctx("writer"), { loginId: second.loginId })
    const cancelled = await handlers.get("terminal.agentAuthLoginState")!(ctx("writer"), {
      loginId: second.loginId,
    })
    expect(cancelled).toMatchObject({ phase: "failed", error: { code: "LOGIN_CANCELLED" } })
  })

  it("the person's Claude sessions open with their own config dir (no token in env); others' never do", async () => {
    const { handlers, created, scripts, store } = setup({ writer: "write", other: "write" })
    expect((await signIn(handlers)).phase).toBe("done")
    const dir = claudeConfigDir("writer")
    const before = scripts.length
    await create(handlers, ctx("writer"), "t1")
    expect(created[0].opts.env).toEqual({ CLAUDE_CONFIG_DIR: dir })
    expect(created[0].meta.auth).toBe("fake.person@example.com (Max)")
    expect(JSON.stringify(created[0])).not.toContain("sk-ant-")
    // The dir is built before the session starts; the credential travels in the script (stdin), not in env or argv.
    const built = scripts.slice(before).find((x) => x.includes("const account ="))
    expect(built).toContain(JSON.stringify(dir))
    expect(built).toContain(FAKE_TOKEN)
    expect(store.synced.length).toBe(0) // the dir was new: nothing to bring back
    // A session restart (new session) gets the same dir.
    await create(handlers, ctx("writer"), "t2")
    expect(created[1].opts.env).toEqual({ CLAUDE_CONFIG_DIR: dir })
    const afterOwner = scripts.length
    await create(handlers, ctx("other"), "t3")
    expect(created[2].opts.env).toBeUndefined()
    expect(scripts.slice(afterOwner).some((x) => x.includes(FAKE_TOKEN) || x.includes(dir))).toBe(
      false,
    )
    await create(handlers, bridgeCtx("writer"), "t4")
    expect(created[3].opts.env).toBeUndefined()
    // Sign out removes the dir from the hosts it was built on.
    await handlers.get("terminal.agentAuthSignOut")!(ctx("writer"), {
      agent: "claude",
      workspaceId: "work_1",
    })
    expect(scripts.at(-1)).toBe(removeClaudeDirScript(dir))
  })

  it("an older setup-token sign-in still works through the environment", async () => {
    const { handlers, created, store } = setup()
    await store.setSecret("writer", "claude", "subscription", FAKE_TOKEN, "Claude subscription")
    await create(handlers, ctx("writer"), "t1")
    expect(created[0].opts.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN })
  })

  it("a person without an account sign-in gets any leftover config dir of theirs removed", async () => {
    const { handlers, created, scripts } = setup()
    await create(handlers, ctx("writer"), "t1")
    expect(created[0].opts.env).toBeUndefined()
    expect(scripts).toContain(removeClaudeDirScript(claudeConfigDir("writer")))
    // Never for a bridge call: an agent session must not remove its owner's dir.
    const before = scripts.length
    await create(handlers, bridgeCtx("writer"), "t2")
    expect(scripts.slice(before).some((x) => x.startsWith("rm -rf"))).toBe(false)
  })
})
