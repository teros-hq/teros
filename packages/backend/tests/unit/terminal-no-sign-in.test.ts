import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { COLLECTIONS } from "../../src/db"
import { register } from "../../src/handlers/domains/terminal/index"
import { PtyManager } from "../../src/services/pty-manager"

function registeredActions(): string[] {
  const actions: string[] = []
  register({ register: (action: string) => actions.push(action) } as any, {
    pubSubService: { subscribeSession() {}, unsubscribeSession() {}, broadcastToTopic() {} } as any,
    ptyManager: new PtyManager({ broadcastToTopic() {} } as any),
    mcaService: { getApp: async () => null } as any,
    mcaManager: {} as any,
    db: { collection: () => ({ findOne: async () => null }) } as any,
  })
  return actions
}

describe("Teros does not handle a Claude sign-in", () => {
  it("[TW-AC-22] the terminal domain has no sign-in action", () => {
    const actions = registeredActions()
    expect(actions).toContain("terminal.create")
    expect(actions.filter((a) => /auth|login|signin/i.test(a))).toEqual([])
  })

  it("[TW-AC-22] no collection holds coding-agent credentials", () => {
    expect(Object.values(COLLECTIONS).filter((name) => /coding.?agent/i.test(name))).toEqual([])
  })

  it("[TW-AC-22] a migration drops the old credential collection", () => {
    const dir = join(import.meta.dir, "../../src/migrations")
    const dropping = readdirSync(dir).filter((f) => {
      const source = readFileSync(join(dir, f), "utf8")
      return (
        source.includes(["coding", "agent", "credentials"].join("_")) && source.includes(".drop()")
      )
    })
    expect(dropping.length).toBe(1)
  })

  it("[TW-AC-20] the terminal services have no code for a tool's login", () => {
    const dir = join(import.meta.dir, "../../src/services/terminal")
    const hits = readdirSync(dir).filter((f) =>
      /claudeAiOauth|oauthAccount|\.credentials\.json|CLAUDE_CODE_OAUTH_TOKEN|refresh_token/.test(
        readFileSync(join(dir, f), "utf8"),
      ),
    )
    expect(hits).toEqual([])
  })
})
