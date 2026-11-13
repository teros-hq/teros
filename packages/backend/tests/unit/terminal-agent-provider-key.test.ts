import { describe, expect, it } from "bun:test"
import type { WsHandlerContext } from "@teros/shared"
import { register } from "../../src/handlers/domains/terminal/index"
import { PtyManager } from "../../src/services/pty-manager"
import { agentProviderEnv } from "../../src/services/terminal/agent-provider-key"

const providers = (list: any[], secrets: Record<string, any>) => ({
  listUserProviders: async () => list,
  getProviderSecrets: async (_user: string, providerId: string) => secrets[providerId] ?? null,
})

describe("the API key an agent's Claude Code session runs on", () => {
  it("[TW-AC-23] the owner's Anthropic provider key goes in as ANTHROPIC_API_KEY", async () => {
    const env = await agentProviderEnv(
      providers([{ providerId: "p1", providerType: "anthropic", status: "active" }], {
        p1: { apiKey: "sk-ant-test" },
      }) as any,
      "u_owner",
    )
    expect(env).toEqual({ ANTHROPIC_API_KEY: "sk-ant-test" })
  })

  it("[TW-AC-23] a MiniMax provider goes in as its Anthropic-compatible endpoint and token", async () => {
    const env = await agentProviderEnv(
      providers([{ providerId: "p2", providerType: "minimax" }], {
        p2: { apiKey: "mm-key" },
      }) as any,
      "u_owner",
    )
    expect(env).toEqual({
      ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic",
      ANTHROPIC_AUTH_TOKEN: "mm-key",
    })
  })

  it("[TW-AC-23] a provider that holds no API key (a subscription sign-in) is never used", async () => {
    const env = await agentProviderEnv(
      providers(
        [
          { providerId: "p3", providerType: "anthropic", status: "active" },
          { providerId: "p4", providerType: "anthropic", status: "disabled" },
        ],
        { p3: { accessToken: "oauth", refreshToken: "r" }, p4: { apiKey: "sk-off" } },
      ) as any,
      "u_owner",
    )
    expect(env).toBeNull()
  })

  it("[TW-AC-23] no provider, no owner or no provider service: nothing", async () => {
    expect(await agentProviderEnv(providers([], {}) as any, "u_owner")).toBeNull()
    expect(await agentProviderEnv(providers([], {}) as any, "")).toBeNull()
    expect(await agentProviderEnv(null, "u_owner")).toBeNull()
  })
})

describe("who gets that key", () => {
  async function setup() {
    const manager = new PtyManager({ broadcastToTopic() {} } as any)
    const started: Array<{ terminalId: string; createdBy: string; env: unknown }> = []
    const host = {
      appId: "app_bash_a",
      key: "app_bash_a",
      container: "teros-term-fake",
      workspaceId: "work_a",
      runScript: async () => ({ code: 0, stdout: "", stderr: "" }),
    }
    manager.useTermHosts({
      stackId: "teros_test",
      all: () => [],
      running: async () => host,
      ensure: async () => host,
      discover: async () => [],
    } as any)
    ;(manager as any).createInHost = async (
      _host: unknown,
      terminalId: string,
      _cols: number,
      _rows: number,
      _workspace: string,
      meta: { createdBy: string },
      options: { env?: unknown },
    ) => {
      started.push({ terminalId, createdBy: meta.createdBy, env: options.env })
    }
    const handlers = new Map<string, (ctx: WsHandlerContext, data: unknown) => Promise<any>>()
    register({ register: (a: string, h: any) => handlers.set(a, h) } as any, {
      pubSubService: {
        subscribeSession() {},
        unsubscribeSession() {},
        broadcastToTopic() {},
      } as any,
      ptyManager: manager,
      mcaService: {
        getApp: async (appId: string) => ({ appId, ownerId: "work_a", mcaId: "mca.teros.bash" }),
      } as any,
      mcaManager: {} as any,
      db: {
        collection: (name: string) => ({
          findOne: async (filter: any) =>
            name === "workspaces"
              ? { workspaceId: filter.workspaceId, ownerId: "u_owner", status: "active" }
              : null,
        }),
      } as any,
      providerService: providers([{ providerId: "p1", providerType: "anthropic" }], {
        p1: { apiKey: "sk-ant-owner" },
      }) as any,
      identities: {
        human: async (id: string) => ({ kind: "human", id, name: id }),
        agent: async () => ({ kind: "agent", id: "agent_rex", name: "Rex" }),
      },
    })
    const create = (ctx: Partial<WsHandlerContext>, terminalId: string, preset: string) =>
      handlers.get("terminal.create")!({ ip: "127.0.0.1", ...ctx } as any, {
        terminalId,
        appId: "app_bash_a",
        preset,
        subscribe: false,
      }).catch((err: Error) => err.message)
    return { create, started }
  }

  it("[TW-AC-23] an agent's Claude Code session gets the owner's key; its plain shell does not", async () => {
    const { create, started } = await setup()
    await create({ userId: "u_owner", sessionId: "mca:app_term_a" }, "t_claude", "claude")
    await create({ userId: "u_owner", sessionId: "mca:app_term_a" }, "t_shell", "shell")
    expect(started).toEqual([
      {
        terminalId: "t_claude",
        createdBy: "agent:app_term_a",
        env: { ANTHROPIC_API_KEY: "sk-ant-owner" },
      },
      { terminalId: "t_shell", createdBy: "agent:app_term_a", env: undefined },
    ])
  })

  it("[TW-AC-23] a person's Claude Code session gets nothing injected: they sign in by themselves", async () => {
    const { create, started } = await setup()
    await create({ userId: "u_owner", sessionId: "sess_owner" }, "t_mine", "claude")
    expect(started).toEqual([{ terminalId: "t_mine", createdBy: "u_owner", env: undefined }])
  })
})
