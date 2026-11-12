# mca.teros.onepassword

Read-only access to 1Password vaults for Teros agents, via a **1Password Service Account**.

Agents can discover vaults, list items, and read item fields — **including secret values** (API keys, passwords, credentials) — so they can fetch secrets on demand (e.g. writing an API key to `.secrets/system/`) without Pablo having to copy keys by hand.

> **Read-only by design.** This MCA only exposes `vaults.list`, `items.list`, `items.get` from the SDK. There are no tools to create, update, delete, or archive anything in 1Password. A test enforces this at the source level (see `test/unit/onepassword.test.ts`, "read-only surface").

## Tools

| Tool | What it does |
|---|---|
| `-health-check` | Verifies the Service Account token + connectivity (lists vaults). |
| `list-vaults` | Vaults accessible to the Service Account (id, title, description, type, active item count). |
| `list-items` | Items in a vault (id, title, category, tags, state — **no field values**). Archived items excluded by default (`includeArchived: true` to include). |
| `get-item-fields` | Fields of an item **with secret values**. Resolves `sectionId` → section title. Also reports `hasNotes`. |

Typical flow: `list-vaults` → `list-items` → `get-item-fields`.

## Why a Service Account (integration path)

Three options were evaluated for programmatic access from Teros:

| Option | Verdict | Why |
|---|---|---|
| **1Password Connect** | ❌ rejected | Requires deploying and operating a self-hosted Connect server (extra infra to babysit on RAW, extra attack surface). |
| **CLI `op`** | ❌ rejected | Not installed on the host or in the `teros/mca-runtime` image (verified). Adding it means an external binary + session management in every container. |
| **Service Account** | ✅ **chosen** | A single token created in 1Password.com. No server, no CLI, no interactive session. Scoped permissions (`can read items`) per vault — least privilege by construction. |

Technical note: Service Account tokens do **not** authenticate against the hosted Connect REST API (`connect.1password.com`). The official `@1password/sdk` uses an encrypted session protocol (SRP + session keys, endpoints on `*.ent.1password.com`, implemented in a WASM core) — which is why this MCA depends on the SDK rather than a plain HTTP client. Verified empirically: SDK loads under Bun 1.3.4 and returns a clean, typed error for an invalid token.

## Connect your 1Password account (Pablo's 3 steps)

1. **Create a Service Account** — on 1Password.com: **Developer → Service Accounts → New Service Account** (or the equivalent section in your account settings). Give it a name like `Teros (RAW)`.
2. **Grant vault access** — in the Service Account settings, mark the vaults it should read (e.g. your main vault) with **"Can read items"**. Only mark the vaults you want agents to see.
3. **Copy the token and paste it in Teros** — copy the generated Service Account token, then in Teros open the 1Password app settings and set it as the `OP_SERVICE_ACCOUNT_TOKEN` secret. That's it — the health check should go green.

> The token is a user secret (`userSecrets: ["OP_SERVICE_ACCOUNT_TOKEN"]` in the manifest): it is stored encrypted with the app instance, never logged, and only used to create the SDK client.

## Security

- **Read-only**: no write/delete/archive surface exists in this MCA (enforced by test).
- **Least privilege**: the Service Account only reads the vaults you explicitly marked. No vault access = nothing visible.
- **Secrets are not logged or persisted**: tool responses with secret values are returned to the agent for the requested action only (e.g. writing `.secrets/system/deepgram.json`). The client does not log field values; the MCA does not cache items to disk. Agents are instructed (tool description) to treat returned values as sensitive and not echo/persist them beyond the requested action.
- **Token never leaves the app instance**: it lives in the app's encrypted secrets, and is only used in-memory to create the SDK client (one client per token, cached).

## Development

```bash
cd mcas/mca.teros.onepassword
bun test test/unit/          # contract + registry-sync tests (SDK mocked)
```

- `src/lib/onepassword-client.ts` — SDK wrapper with injectable `clientFactory` (for tests), per-token client cache, descriptive error when the token is missing.
- `src/tools/*.ts` — one file per tool, holded-style.
- `test/unit/registry-sync.test.ts` — keeps `tools.json` ↔ `src/index.ts` in sync (names + descriptions + schemas).

### Deploy note (new npm dependency)

This MCA adds `@1password/sdk` as a dependency. MCAs run inside `teros/mca-runtime` Docker containers, where dependencies are baked into the image from the union of all MCA `package.json`s. After adding/changing a dependency, regenerate and rebuild the runtime image:

```bash
bun scripts/gen-mca-union-deps.mjs
bash scripts/build-mca-runtimes.sh
```

(For local stdio testing from the worktree, dependencies resolve from the repo root `node_modules` — no local install needed inside the MCA dir.)
