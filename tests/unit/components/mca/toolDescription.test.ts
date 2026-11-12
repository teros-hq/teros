/**
 * Tool-call header description standard (primitives/tool-description.ts).
 *
 * Pins the two promises the standard makes to every renderer:
 *   - one string per phase (pending / running / completed / failed), with
 *     approval waits reading like `pending`;
 *   - a header never shows an id: id-shaped or missing names switch the
 *     description to its `<phase>Generic` copy.
 */

import { describe, expect, it } from "bun:test"
import {
  describeToolCall,
  descriptionPhase,
  displayName,
  firstName,
  looksLikeId,
} from "../../../../packages/app/src/components/mca/primitives/tool-description"

const STRINGS: Record<string, string> = {
  "k.pending": "Give {{agent}} access to {{app}}",
  "k.running": "Giving {{agent}} access to {{app}}",
  "k.completed": "Gave {{agent}} access to {{app}}",
  "k.failed": "Couldn't give {{agent}} access to {{app}}",
  "k.pendingGeneric": "Give an agent access to an app",
  "k.runningGeneric": "Giving an agent access to an app",
  "k.completedGeneric": "Gave an agent access to an app",
  "k.failedGeneric": "Couldn't give the agent access to the app",
  "plain.completed": "Listed agents",
}

/** Minimal i18next stand-in: lookup + {{var}} interpolation + defaultValue. */
function t(key: string, options: Record<string, unknown> = {}): string {
  const raw = STRINGS[key]
  if (raw === undefined) return (options.defaultValue as string | undefined) ?? key
  return raw.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options[name] ?? ""))
}

describe("descriptionPhase", () => {
  it("maps approval and user-input waits to pending", () => {
    expect(descriptionPhase("pending")).toBe("pending")
    expect(descriptionPhase("pending_permission")).toBe("pending")
    expect(descriptionPhase("pending_user_input")).toBe("pending")
    expect(descriptionPhase("running")).toBe("running")
    expect(descriptionPhase("completed")).toBe("completed")
    expect(descriptionPhase("failed")).toBe("failed")
  })
})

describe("looksLikeId", () => {
  it.each([
    "agent_9f3a12bc44d0e1aa",
    "app_1a2b3c4d5e",
    "task_0123456789abcdef",
    "3f2b6c1e-8a4d-4c2e-9b7a-1d2e3f4a5b6c",
    "65f1c2a9b8e7d6c5b4a39281",
    "C0123ABCD45",
    "people/c1234567890",
    "AAMkAGI2THVSAAA0MDEyMzQ1Njc4OQ",
    "agent_9f3a…e1aa",
  ])("flags %s", (value) => {
    expect(looksLikeId(value)).toBe(true)
  })

  it.each(["Gmail", "Alice", "alice@example.com", "Q3 budget", "my-project", "flux-schnell", "ENG-123", "Marketing team"])(
    "keeps %s",
    (value) => {
      expect(looksLikeId(value)).toBe(false)
    },
  )
})

describe("displayName / firstName", () => {
  it("drops empty and id-shaped values", () => {
    expect(displayName("  ")).toBeUndefined()
    expect(displayName("agent_9f3a12bc44d0e1aa")).toBeUndefined()
    expect(displayName(undefined)).toBeUndefined()
    expect(displayName("  Alice ")).toBe("Alice")
  })

  it("returns the first human name among the candidates", () => {
    expect(firstName(undefined, "app_1a2b3c4d5e", "Gmail")).toBe("Gmail")
    expect(firstName(undefined, "")).toBeUndefined()
  })
})

describe("describeToolCall", () => {
  const names = { agent: "Alice", app: "Gmail" }

  it("picks the phase string and interpolates names", () => {
    expect(describeToolCall(t, "k", "pending_permission", names)).toBe("Give Alice access to Gmail")
    expect(describeToolCall(t, "k", "running", names)).toBe("Giving Alice access to Gmail")
    expect(describeToolCall(t, "k", "completed", names)).toBe("Gave Alice access to Gmail")
    expect(describeToolCall(t, "k", "failed", names)).toBe("Couldn't give Alice access to Gmail")
  })

  it("falls back to the generic copy when a name is missing", () => {
    expect(describeToolCall(t, "k", "completed", { agent: undefined, app: "Gmail" })).toBe(
      "Gave an agent access to an app",
    )
  })

  it("never interpolates an id: id-shaped names count as missing", () => {
    const out = describeToolCall(t, "k", "completed", { agent: "agent_9f3a12bc44d0e1aa", app: "Gmail" })
    expect(out).toBe("Gave an agent access to an app")
    expect(out).not.toContain("agent_")
  })

  it("uses the phase string directly when the tool takes no names", () => {
    expect(describeToolCall(t, "plain", "completed")).toBe("Listed agents")
  })
})
