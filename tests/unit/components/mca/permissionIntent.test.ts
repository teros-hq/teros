/**
 * Unit tests — permission intent precedence.
 *
 * The spec sanctions exactly one presentation-precedence chain and requires it to
 * be OBSERVABLE rather than silent (engineering principle 2): every resolution
 * reports which layer produced it, so layer-4 usage is a measurable coverage gap
 * instead of a hidden substitution.
 */

import { describe, expect, it, test } from "bun:test"
import {
  INTENT_TEMPLATE_MAX_CHARS,
  renderIntentTemplate,
  resolveIntent,
} from "../../../../packages/app/src/components/mca/primitives/permission-intent"

const FALLBACK = "Wants to share file"

describe("resolveIntent", () => {
  it("(1) layer 1 — a per-MCA override wins over everything", () => {
    const result = resolveIntent({
      toolName: "bash_run",
      mcaId: "mca.teros.bash",
      input: { command: "rm -rf build/" },
      detail: {
        description: "Run a shell command.",
        annotations: { summary: "Runs a shell command." },
      },
      fallbackText: FALLBACK,
    })

    expect(result.source).toBe("override")
    expect(result.text).toContain("rm -rf build/")
  })

  it("(2) layer 2 — annotations.summary wins when no override matches", () => {
    const result = resolveIntent({
      toolName: "mydrive_share-file",
      mcaId: "mca.google.drive",
      input: { fileId: "f1" },
      detail: {
        description: "Grant another account access to a Drive file.",
        annotations: { summary: "Shares a file with someone." },
      },
      fallbackText: FALLBACK,
    })

    expect(result).toEqual({ text: "Shares a file with someone.", source: "summary" })
  })

  it("(3) layer 3 — the tool description when there is no summary", () => {
    const result = resolveIntent({
      toolName: "mydrive_share-file",
      mcaId: "mca.google.drive",
      input: { fileId: "f1" },
      detail: { description: "Grant another account access to a Drive file." },
      fallbackText: FALLBACK,
    })

    expect(result).toEqual({
      text: "Grant another account access to a Drive file.",
      source: "description",
    })
  })

  it("(4) layer 4 — the caller's tense fallback when no metadata arrived", () => {
    const result = resolveIntent({
      toolName: "mydrive_share-file",
      mcaId: "mca.google.drive",
      fallbackText: FALLBACK,
    })

    expect(result).toEqual({ text: FALLBACK, source: "tense" })
  })

  it("(5) an override that returns null falls through to the next layer", () => {
    // Bash's override returns null when no command is present.
    const result = resolveIntent({
      toolName: "bash_run",
      mcaId: "mca.teros.bash",
      input: {},
      detail: { description: "Run a shell command." },
      fallbackText: FALLBACK,
    })

    expect(result.source).toBe("description")
  })

  it("(6) the admin variants of bash and filesystem are registered too", () => {
    const bash = resolveIntent({
      toolName: "adminbash_run",
      mcaId: "mca.teros.admin.bash",
      input: { command: "ls -la" },
      fallbackText: FALLBACK,
    })
    expect(bash.source).toBe("override")

    const fs = resolveIntent({
      toolName: "adminfs_delete",
      mcaId: "mca.teros.admin.filesystem",
      input: { path: "/workspace/tmp.txt" },
      fallbackText: FALLBACK,
    })
    expect(fs.source).toBe("override")
  })

  it("(7) the filesystem override receives the SHORT tool name", () => {
    // toolName is namespaced; the override keys on `delete`, not `fs_delete`.
    const result = resolveIntent({
      toolName: "fs_delete",
      mcaId: "mca.teros.filesystem",
      input: { path: "/workspace/notes.md" },
      fallbackText: FALLBACK,
    })

    expect(result.source).toBe("override")
    expect(result.text).toContain("notes.md")
  })

  it("(8) an unknown mcaId skips layer 1 entirely", () => {
    const result = resolveIntent({
      toolName: "whatever_do-thing",
      mcaId: "mca.unknown",
      input: { command: "rm -rf /" },
      detail: { description: "Does a thing." },
      fallbackText: FALLBACK,
    })

    expect(result.source).toBe("description")
  })

  it("(9) an absent mcaId skips layer 1 without throwing", () => {
    const result = resolveIntent({ toolName: "x_y", fallbackText: FALLBACK })
    expect(result).toEqual({ text: FALLBACK, source: "tense" })
  })

  it("(10) a blank summary or description is treated as absent, not rendered empty", () => {
    const result = resolveIntent({
      toolName: "mydrive_share-file",
      detail: { description: "   ", annotations: { summary: "" } },
      fallbackText: FALLBACK,
    })

    expect(result).toEqual({ text: FALLBACK, source: "tense" })
  })
})

// ─── guard coverage added in review. `resolveIntent` runs during render with no
// error boundary anywhere in the chat or MCA trees, so anything it throws blanks
// the whole chat and the user can neither approve nor deny. Layer 1 receives raw,
// unvalidated LLM tool arguments — validation happens in the MCA, AFTER approval
// — so a wrong-typed argument is exactly the input the gate must survive.

describe("resolveIntent — contract guards", () => {
  it("(11) throws when toolName is empty", () => {
    expect(() => resolveIntent({ toolName: "", fallbackText: FALLBACK })).toThrow(
      /resolveIntent: toolName is required/,
    )
  })

  it("(12) throws when fallbackText is not a string", () => {
    expect(() =>
      resolveIntent({ toolName: "mydrive_share-file", fallbackText: undefined as never }),
    ).toThrow(/resolveIntent: fallbackText is required \(toolName=mydrive_share-file\)/)
  })
})

describe("resolveIntent — layer 1 survives hostile input", () => {
  it("(13) a non-string command declines the override instead of throwing", () => {
    const result = resolveIntent({
      toolName: "bash_run",
      mcaId: "mca.teros.bash",
      input: { command: 123 },
      detail: { description: "Run a shell command." },
      fallbackText: FALLBACK,
    })

    expect(result.source).toBe("description")
    expect(result.text).toBe("Run a shell command.")
  })

  it("(14) a non-string filesystem path declines the override instead of throwing", () => {
    const result = resolveIntent({
      toolName: "fs_delete",
      mcaId: "mca.teros.filesystem",
      input: { path: 42 },
      fallbackText: FALLBACK,
    })

    expect(result).toEqual({ text: FALLBACK, source: "tense" })
  })

  it("(15) a container where a string was expected declines the override", () => {
    expect(
      resolveIntent({
        toolName: "bash_run",
        mcaId: "mca.teros.bash",
        input: { command: {} },
        fallbackText: FALLBACK,
      }).source,
    ).toBe("tense")

    expect(
      resolveIntent({
        toolName: "fs_delete",
        mcaId: "mca.teros.filesystem",
        input: { path: [] },
        fallbackText: FALLBACK,
      }).source,
    ).toBe("tense")
  })

  it("(16) an override that throws is reported and falls through, never escaping", () => {
    // Defense in depth: narrowing handles the known shapes, but a future override
    // must not be able to take the approval UI down. The failure is REPORTED, not
    // swallowed — silence here would violate engineering principle 2.
    const reported: unknown[] = []
    const boom = new Error("override exploded")

    const result = resolveIntent({
      toolName: "bash_run",
      mcaId: "mca.teros.bash",
      input: {
        get command(): string {
          throw boom
        },
      },
      fallbackText: FALLBACK,
      onOverrideError: (error) => reported.push(error),
    })

    expect(result).toEqual({ text: FALLBACK, source: "tense" })
    expect(reported).toEqual([boom])
  })

  it("(17) a whitespace-only toolName still resolves rather than crashing", () => {
    const result = resolveIntent({ toolName: "   ", fallbackText: FALLBACK })

    expect(result).toEqual({ text: FALLBACK, source: "tense" })
  })

  it("(18) a tool name that is only separators does not produce an empty short name", () => {
    const result = resolveIntent({
      toolName: "__",
      mcaId: "mca.teros.filesystem",
      fallbackText: FALLBACK,
    })

    expect(result.text.length).toBeGreaterThan(0)
  })
})

describe("renderIntentTemplate", () => {
  test("interpolates string params", () => {
    expect(renderIntentTemplate("Delete the file at {path}", { path: "src/a.ts" })).toBe(
      "Delete the file at src/a.ts",
    )
  })

  test("interpolates numbers and booleans", () => {
    expect(
      renderIntentTemplate("Fetch {count} items (recursive: {deep})", {
        count: 20,
        deep: true,
      }),
    ).toBe("Fetch 20 items (recursive: true)")
  })

  test("declines when a referenced param is absent", () => {
    expect(renderIntentTemplate("Delete the file at {path}", {})).toBeNull()
  })

  test("declines when a referenced param is an object", () => {
    expect(renderIntentTemplate("Send to {to}", { to: { email: "a@b.c" } })).toBeNull()
  })

  test("declines when a referenced param is an array", () => {
    expect(renderIntentTemplate("Delete {paths}", { paths: ["a", "b"] })).toBeNull()
  })

  test("declines when input is absent entirely", () => {
    expect(renderIntentTemplate("Delete the file at {path}", undefined)).toBeNull()
  })

  test("returns a template with no placeholders unchanged", () => {
    expect(renderIntentTemplate("Lists your calendars", {})).toBe("Lists your calendars")
  })

  test("strips newlines so the intent line cannot become a paragraph", () => {
    expect(renderIntentTemplate("Run\n{cmd}", { cmd: "ls\n-la" })).toBe("Run ls -la")
  })

  test("clips an over-long interpolation", () => {
    const long = "x".repeat(500)
    const rendered = renderIntentTemplate("Write {body}", { body: long })

    expect(rendered).not.toBeNull()
    expect((rendered as string).length).toBeLessThanOrEqual(INTENT_TEMPLATE_MAX_CHARS)
    expect(rendered).toMatch(/…$/)
  })
})

// ─── final review F3: an over-long argument used to clip the ASSEMBLED sentence,
// eliding the author's own consequence clause. The clip now applies per value.
// Split into its own describe so the block above stays under the complexity limit.

describe("renderIntentTemplate — the author's words survive a long argument", () => {
  // The clip applies to the VALUE, not the assembled sentence: the argument is
  // model-chosen and the template's words are not, so a long argument must never
  // be able to elide the author's consequence clause ("from production" here) —
  // that clause is the whole reason the reviewer would decline.
  test("a long argument cannot elide the author's trailing clause", () => {
    const rendered = renderIntentTemplate("Delete {path} from production", {
      path: "x".repeat(500),
    })

    expect(rendered).not.toBeNull()
    expect(rendered as string).toStartWith("Delete x")
    expect(rendered as string).toEndWith("… from production")
    expect((rendered as string).length).toBeLessThanOrEqual(INTENT_TEMPLATE_MAX_CHARS)
  })

  test("every placeholder keeps a share of the budget, all clauses intact", () => {
    const rendered = renderIntentTemplate("Copy {src} to {dest} on the shared drive", {
      src: "a".repeat(300),
      dest: "b".repeat(300),
    })

    expect(rendered).not.toBeNull()
    expect(rendered as string).toContain("a…")
    expect(rendered as string).toContain("b…")
    expect(rendered as string).toEndWith(" on the shared drive")
    expect((rendered as string).length).toBeLessThanOrEqual(INTENT_TEMPLATE_MAX_CHARS)
  })

  // When the author's OWN text nearly fills the cap there is nothing left to give
  // the value, so the per-value floor applies and the assembled bound is what
  // bites. That is the author's over-long template being clipped, not an argument
  // eliding the author's words — the value is still identifiable.
  test("keeps the line bounded when the template itself nearly fills the cap", () => {
    const rendered = renderIntentTemplate(`${"word ".repeat(37)}{path}`, {
      path: "/etc/passwd-and-a-very-long-tail-that-must-be-clipped",
    })

    expect(rendered).not.toBeNull()
    expect(rendered as string).toContain("/etc/passwd")
    expect((rendered as string).length).toBeLessThanOrEqual(INTENT_TEMPLATE_MAX_CHARS)
  })
})

// ─── review round 1: an Important finding (bidi overrides can rewrite the
// sentence's visible meaning) plus minors on surrogate-safe clipping, blank/
// non-finite values, and unpinned decline paths. Split into its own describe
// so this block, like "resolveIntent — layer 1 survives hostile input" above,
// stays under the complexity limit instead of growing the happy-path block.

describe("renderIntentTemplate — hostile input", () => {
  test("clips without splitting a surrogate pair, never yielding U+FFFD", () => {
    // 192 x's puts the emoji exactly on the clip boundary: "Write " costs 6 of the
    // 200-char cap, leaving a 194-char value budget clipped at 193 for the "…".
    const body = `${"x".repeat(192)}😀tail`
    const rendered = renderIntentTemplate("Write {body}", { body })

    expect(rendered).not.toBeNull()
    expect(rendered).not.toContain("�")
    expect(rendered).toMatch(/…$/)
  })

  test("strips a bidi override so a param cannot rewrite the sentence's appearance", () => {
    // U+202E (RLO) would visually reverse everything after it — e.g. rendering
    // "safe.txt‮gpj.exe" as "safe.txtexe.jpg" — which lets a model-chosen
    // argument disguise what the human is approving.
    const rendered = renderIntentTemplate("Delete {p}", { p: "safe.txt‮gpj.exe" })

    expect(rendered).toBe("Delete safe.txtgpj.exe")
  })

  test("strips zero-width characters from an interpolated value", () => {
    const rendered = renderIntentTemplate("Delete {p}", { p: "safe​.txt" })

    expect(rendered).toBe("Delete safe.txt")
  })

  test("declines on a blank interpolated string", () => {
    expect(renderIntentTemplate("Delete the file at {path}", { path: "" })).toBeNull()
    expect(renderIntentTemplate("Delete the file at {path}", { path: "   " })).toBeNull()
  })

  test("declines on a non-finite interpolated number", () => {
    expect(renderIntentTemplate("Fetch {count} items", { count: Number.NaN })).toBeNull()
    expect(
      renderIntentTemplate("Fetch {count} items", { count: Number.POSITIVE_INFINITY }),
    ).toBeNull()
  })

  test("declines when a referenced param is null", () => {
    expect(renderIntentTemplate("Delete {p}", { p: null })).toBeNull()
  })

  test("declines when only some of several placeholders resolve", () => {
    expect(renderIntentTemplate("Copy {src} to {dst}", { src: "a.ts" })).toBeNull()
  })
})

describe("resolveIntent — template layer", () => {
  const base = { toolName: "mydrive_delete-file", fallbackText: "Wants to delete file" }

  test("a template wins over summary and description", () => {
    const result = resolveIntent({
      ...base,
      input: { path: "src/a.ts" },
      detail: {
        description: "Deletes a file by path",
        annotations: {
          summary: "Removes a file from the workspace",
          intentTemplate: "Delete the file at {path}",
        },
      },
    })

    expect(result).toEqual({ text: "Delete the file at src/a.ts", source: "template" })
  })

  test("a per-MCA override still wins over a template", () => {
    const result = resolveIntent({
      toolName: "bash_execute",
      mcaId: "mca.teros.bash",
      input: { command: "rm -rf build" },
      detail: {
        description: "Runs a shell command",
        annotations: { intentTemplate: "Run {command}" },
      },
      fallbackText: "Wants to execute",
    })

    expect(result.source).toBe("override")
  })

  test("an undeclinable template falls through to summary, not to tense", () => {
    const result = resolveIntent({
      ...base,
      input: {},
      detail: {
        description: "Deletes a file by path",
        annotations: {
          summary: "Removes a file from the workspace",
          intentTemplate: "Delete the file at {path}",
        },
      },
    })

    expect(result).toEqual({
      text: "Removes a file from the workspace",
      source: "summary",
    })
  })

  test("a blank template is ignored", () => {
    const result = resolveIntent({
      ...base,
      input: { path: "src/a.ts" },
      detail: { description: "Deletes a file by path", annotations: { intentTemplate: "   " } },
    })

    expect(result.source).toBe("description")
  })
})

// ─── The placeholder grammar is `{` + [A-Za-z0-9_]+ + `}` and nothing else.
// Before this block, a name outside that set (JSON Schema permits `file-id` and
// `page.size`; kebab-case is common in this ecosystem) fell through the replace
// untouched, so `"Share {file-id} with {email}"` rendered as
// `"Share {file-id} with a@b.c"` — literal braces in the security-critical
// sentence, neither interpolated nor declined, which is what the protocol's MUST
// forbids. `{` is now reserved: any brace the grammar cannot resolve declines.
// Split into its own describe so the blocks above stay under the complexity limit.

describe("renderIntentTemplate — the placeholder grammar", () => {
  test("declines a hyphenated placeholder instead of emitting literal braces", () => {
    const rendered = renderIntentTemplate("Share {file-id} with {email}", {
      "file-id": "abc",
      email: "a@b.c",
    })

    expect(rendered).toBeNull()
  })

  test("declines a dotted placeholder instead of emitting literal braces", () => {
    expect(renderIntentTemplate("Fetch {page.size} rows", { "page.size": 10 })).toBeNull()
  })

  test("declines a brace sequence that is not a placeholder at all", () => {
    expect(renderIntentTemplate("Set {} to 5", {})).toBeNull()
    expect(renderIntentTemplate("Delete {path", { path: "src/a.ts" })).toBeNull()
    expect(renderIntentTemplate("Delete the file at {path} }", { path: "src/a.ts" })).toBeNull()
  })

  test("a placeholder-free template still renders — it is not a brace failure", () => {
    expect(renderIntentTemplate("Lists your calendars", {})).toBe("Lists your calendars")
    expect(renderIntentTemplate("Lists your calendars", undefined)).toBe("Lists your calendars")
  })

  // A brace inside a model-generated ARGUMENT is that argument's own content and
  // must not retroactively decline the author's template — the check runs on the
  // template with valid placeholders stripped, never on the assembled line.
  test("a brace inside an interpolated value does not decline the template", () => {
    expect(renderIntentTemplate("Delete the file at {path}", { path: "a{b}.ts" })).toBe(
      "Delete the file at a{b}.ts",
    )
  })
})
