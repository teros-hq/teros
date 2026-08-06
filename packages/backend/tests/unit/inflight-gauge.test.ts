/**
 * Tests for the in-flight LLM-stream gauge (F1.3) — the data behind
 * `admin-api.agent-usage-in-flight`. The handler is a thin wrapper over this
 * process-level counter, so the contract that matters lives here: inc/dec
 * balance, the snapshot is a safe copy, the total sums every upstream, and a
 * decrement never drives a key negative (it deletes at zero instead). That last
 * invariant is what keeps the gauge from drifting below reality after an
 * unbalanced finally — the opposite failure mode of the `status='running'`
 * approach this gauge deliberately replaces (MAYOR-3).
 *
 * Imported from `@teros/core` (the same module the adapter mutates) so we pin
 * the real exported behaviour, not a re-implementation. Each test uses unique
 * provider keys and unwinds its own increments, leaving the shared Map clean.
 */

import { describe, expect, it } from "bun:test"
import {
  decInflight,
  getInflightSnapshot,
  getInflightTotal,
  incInflight,
} from "@teros/core"

describe("inflight-gauge (F1.3)", () => {
  it("increments per provider and totals across providers", () => {
    incInflight("gOneFw")
    incInflight("gOneFw")
    incInflight("gOneTg")
    const snap = getInflightSnapshot()
    expect(snap.gOneFw).toBe(2)
    expect(snap.gOneTg).toBe(1)
    expect(getInflightTotal()).toBe(3)
    // unwind
    decInflight("gOneFw")
    decInflight("gOneFw")
    decInflight("gOneTg")
    expect(getInflightTotal()).toBe(0)
  })

  it("deletes a key at zero instead of leaving a 0 (clean snapshot)", () => {
    incInflight("gTwo")
    decInflight("gTwo")
    expect("gTwo" in getInflightSnapshot()).toBe(false)
  })

  it("a decrement past zero never goes negative (unbalanced finally is safe)", () => {
    decInflight("gNeverIncremented")
    expect(getInflightSnapshot().gNeverIncremented).toBeUndefined()
    incInflight("gThree")
    decInflight("gThree")
    decInflight("gThree") // one extra dec
    expect(getInflightSnapshot().gThree).toBeUndefined()
    expect(getInflightTotal()).toBe(0)
  })

  it("the snapshot is a copy — mutating it does not corrupt the gauge", () => {
    incInflight("gFour")
    const snap = getInflightSnapshot()
    snap.gFour = 999
    snap.gFourInjected = 7
    expect(getInflightSnapshot().gFour).toBe(1)
    expect("gFourInjected" in getInflightSnapshot()).toBe(false)
    decInflight("gFour")
  })
})
