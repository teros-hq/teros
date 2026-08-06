/**
 * EvalSessionStore (F4 · C3) — the thin adapter that makes `@teros/core`'s
 * in-memory store usable as a `ConversationManager` session store.
 *
 * Guards the one bit of real logic: it EXTENDS the abstract `SessionStore` (so
 * `ConversationManager` accepts it at runtime, not just at compile time) and
 * adapts the delegate's `getSession` `null → undefined` mismatch. A break here
 * would make the behavioural gate crash on the first turn.
 */

import { describe, expect, it } from "bun:test"
import { SessionStore } from "@teros/core"
import { EvalSessionStore } from "../../src/eval/eval-session-store"

describe("EvalSessionStore (F4·C3)", () => {
  it("is a real SessionStore (satisfies the abstract base at runtime)", () => {
    expect(new EvalSessionStore() instanceof SessionStore).toBe(true)
  })

  it("returns undefined — NOT null — for a missing session (base contract)", async () => {
    const got = await new EvalSessionStore().getSession("session_missing")
    expect(got).toBeUndefined()
  })

  it("round-trips a written session through the delegate", async () => {
    const store = new EvalSessionStore()
    const session = {
      id: "session_1",
      userId: "u",
      channelId: "ch",
      title: "t",
      time: { created: 1, updated: 1 },
    }
    await store.writeSession(session as never)
    const got = await store.getSession("session_1")
    expect(got?.id).toBe("session_1")
  })
})
