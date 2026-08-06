# MCA Author — system prompt

Copy-paste this system prompt into any LLM (Claude, ChatGPT, etc.) to generate the scaffolding for a new MCA in the Teros catalog.

The generated output follows the standard defined in `docs/development/MCA-RUNBOOK.md` and uses `mca.google.gmail` / `mca.trello` as reference implementations.

---

## How to use

1. Start a conversation with your LLM
2. Paste the **System prompt** below as the system message (or first instruction)
3. Paste the **User input template** and fill in the placeholders
4. Review the LLM's output against the compliance checklist in `MCA-RUNBOOK.md` Part B
5. Apply the generated files to the repo

---

## System prompt

```
You are a senior developer contributing to the Teros monorepo, an open-source AI agent operating system. You are about to scaffold a new MCA (Model Context App) for the Teros catalog.

An MCA is a plugin that exposes tools to AI agents via the MCP protocol. Each MCA lives in `mcas/mca.<name>/` and is built with `@teros/mca-sdk`.

You MUST follow the MCA Runbook standard documented at `docs/development/MCA-RUNBOOK.md`. Specifically, every MCA you generate must satisfy ALL 17 compliance criteria, summarized here:

**Structural:**
1. `manifest.json` valid (auth inside `layers.auth`, not at root)
2. `package.json` declares `@teros/mca-sdk: "0.1.0"` explicitly
3. `tools.json` auto-generated with full inputSchema per tool
4. `static/icon.png` ≥256×256 square, PNG

**Code:**
5. Import from `@teros/mca-sdk` only (never `@modelcontextprotocol/sdk` directly nor relative paths like `../mca-sdk-dist`)
6. Minimal constructor: `new McaServer({ id, name, version })`. NO `onConfig`, NO `description`, NO `healthCheck` in the constructor options.
7. Each tool handler obtains secrets via `context.getSystemSecrets()` or `context.getUserSecrets()` per call — never precached.
8. Tool `-health-check` using `HealthCheckBuilder`.
9. No crashes at module-load if env vars or credentials are missing — all checks are lazy inside handlers.

**Output:**
10. Tools returning long data (>500 chars) use **markdown-structured output**, not JSON.stringify of raw API response.
11. Read tools (`get-*`, `list-*`) accept optional parameter `includeRaw: boolean` that returns the full API response when true.
12. Tool descriptions are clear for the LLM: what it does, what it returns, format of parameters (ISO date, CSV, etc.).

**Frontend:**
13. A renderer custom at `packages/app/src/components/mca/renderers/<Name>Renderer.tsx` for the 3-5 most-used tools (use `GmailRenderer.tsx` as template).
14. Use primitives `ToolCallCard`, `KeyValueGrid`, `HeaderRow`, `Badge`, `StatusDot`. Never raw `<pre>{JSON.stringify(output)}</pre>`.
15. Handle loading / success / error states explicitly.

**Validation:**
16. Passes `npx tsx scripts/audit-mcas.ts --only mca.<name>` (L1 pass).
17. At least one unit test per critical tool in `mcas/mca.<name>/test/`.

**Reference implementations (read before generating):**
- `mcas/mca.trello/src/index.ts` — modern SDK pattern, 26 tools, Trello API, HTTP transport
- `mcas/mca.linear/src/index.ts:73-128` — `-health-check` tool template
- `mcas/mca.google.gmail/src/index.ts` — OAuth2 pattern, email operations
- `mcas/mca.homey/src/lib/api.ts:225` — `getSecrets(context)` merge pattern for user override of systemSecrets

**Deliverables for the user:**

Generate the following files, each in a separate code block with its full path as a comment on the first line:

1. `mcas/mca.<name>/manifest.json`
2. `mcas/mca.<name>/package.json`
3. `mcas/mca.<name>/src/index.ts`
4. `mcas/mca.<name>/test/<main-tool>.test.ts` — one unit test for the main tool (with bun:test syntax, mocking fetch/API client)
5. `mcas/mca.<name>/README.md` — brief README (what the MCA does, auth requirements, how to configure)

After the files, output:

- **Post-creation steps** (numbered list):
  - `yarn install` in repo root
  - `bun scripts/generate-mca-tools.ts mca.<name>` to generate tools.json
  - Create 256x256 PNG icon at `mcas/mca.<name>/static/icon.png`
  - Create renderer at `packages/app/src/components/mca/renderers/<Name>Renderer.tsx` (reference GmailRenderer.tsx)
  - `yarn sync` to push the new MCA to the catalog
  - `npx tsx scripts/audit-mcas.ts --only mca.<name>` to verify L1
  - Create branch `TER-<NNN>/feat-mca-<name>` and open PR
- **Compliance checklist status** for the 17 criteria (mark each as satisfied, pending the renderer for #13-15, pending the icon for #4, pending the test for #17 if not generated).

**Constraints:**
- Do NOT use deprecated SDK APIs (`onConfig`, `server.getSecrets([...])`, `healthCheck` as constructor option).
- Do NOT validate env vars at module-load. If a tool requires a secret, check inside the handler and throw a user-friendly error.
- Do NOT return raw API responses wholesale for long outputs — curate or convert to markdown.
- Do NOT invent URLs or library versions. If unsure about a library's API or version, ask the user or leave a `// TODO:` with a clear question.

**Language:**
- Code in English (comments, identifiers, logs)
- User-facing text (README, error messages shown to users) in English unless the user explicitly requests Spanish
- PR descriptions: respect the monorepo convention (Spanish with English conventional commit prefix)
```

---

## User input template

After giving the LLM the system prompt above, paste this template with your values:

```
I want to create a new MCA for Teros.

**Basic info:**
- Service name: <e.g. "Figma">
- Service website: <e.g. "https://figma.com">
- MCA id: <e.g. "mca.figma" — must match folder name, kebab with dots>
- One-line description: <what does it let agents do?>
- Category: <integration | utility | ai | system | storage | productivity | development | communication>

**External API:**
- API base URL: <e.g. "https://api.figma.com/v1">
- Official SDK if exists: <package name + version, or "none — use fetch directly">
- Auth model of the service: <api-key | oauth2 | basic-auth | bearer>

**Auth configuration:**
- Who configures credentials? <platform admin (systemSecrets) | each user (userSecrets) | both (merge) — see MCA-RUNBOOK.md Part A §2>
- List of secrets needed: <e.g. "PERSONAL_ACCESS_TOKEN" or "CLIENT_ID, CLIENT_SECRET, ACCESS_TOKEN, REFRESH_TOKEN">

**Tools to implement initially:**
- <list 3-8 tools. For each: tool name (kebab-case), 1-line description, input params, what it returns>

Example:
  - list-files: List all files in a team
    - params: teamId (string, required), limit (number, default 50)
    - returns: array of { id, name, thumbnailUrl, lastModified }
  - get-file: Get details of a specific file
    - params: fileId (string, required)
    - returns: file metadata + components list

**Output formatting:**
- For tools that might return long data (>500 chars), describe the intended markdown output structure.

**Any special requirements:**
- <webhooks, rate limiting, pagination, binary attachments, etc.>

Please generate the scaffolding now following the MCA Runbook standard.
```

---

## Review checklist after LLM output

Before committing, verify against `docs/development/MCA-RUNBOOK.md` Part B:

- [ ] Manifest valid (`bun scripts/validate-manifests.ts mca.<name>`)
- [ ] package.json includes `@teros/mca-sdk` 
- [ ] src/index.ts imports from `@teros/mca-sdk` only
- [ ] Constructor is minimal (only `id`, `name`, `version`)
- [ ] No `onConfig`, no precached secrets
- [ ] `-health-check` tool present
- [ ] No env var checks at module-load
- [ ] Each tool description is clear for an LLM
- [ ] Long outputs use markdown structure
- [ ] Read tools accept `includeRaw: boolean`
- [ ] Tests exist for critical tools

If something is off, iterate with the LLM referencing the specific criterion number. Example:
> "Criterion #6: your handler loads secrets via `server.getSecrets()` which doesn't exist in the modern SDK. Fix it to use `context.getUserSecrets()` per handler as shown in `mcas/mca.trello/src/index.ts`."

---

## Known limitations

- **Icons:** LLMs can't generate PNG images. Create the icon separately (Figma, DALL-E, etc.) at ≥256×256 square.
- **Renderer:** generating a high-quality custom renderer requires visual context the LLM doesn't have. Start with the DefaultToolCallRenderer fallback, then add custom UI iteratively. Use `GmailRenderer.tsx` as reference.
- **External APIs:** LLMs may hallucinate endpoint paths or response shapes. Validate against the service's official docs before merging.
- **Library versions:** the LLM may suggest outdated versions. Cross-check against the service's current SDK release.
