# PLAUD MCA

Integration with PLAUD voice recordings via the official Plaud MCP server (`https://mcp.plaud.ai/mcp`).

## Authentication

This MCA uses **OAuth 2.0 authorization-code + PKCE**, managed entirely by the Teros backend. The flow is identical to Gmail, Notion, ClickUp, Canva, etc.:

1. User clicks **"Conectar con Plaud"** in the Teros UI.
2. Teros backend builds the authorization URL with a PKCE code challenge.
3. User authorizes Teros in the browser.
4. Plaud redirects to the standard Teros callback (`/auth/mca/callback`).
5. Backend exchanges the code for tokens and stores them encrypted.
6. MCA receives tokens via user secrets on every tool invocation.

### Required system secrets (admin)

| Secret | Required | Source |
|---|---|---|
| `CLIENT_ID` | **Yes** | Dynamic client registration against Plaud (see `scripts/setup-oauth.ts`) |

### Required user secrets (auto-populated by Teros OAuth)

| Secret | Required | Description |
|---|---|---|
| `ACCESS_TOKEN` | **Yes** | OAuth access token (auto-written by Teros backend) |
| `REFRESH_TOKEN` | No | OAuth refresh token (auto-written by Teros backend) |
| `EXPIRY_DATE` | No | ISO 8601 expiry of the access token (auto-written) |

### Dynamic client registration

Plaud supports **RFC 7591 Dynamic Client Registration**. Run the setup script to obtain a `CLIENT_ID`:

```bash
cd /opt/teros/mcas/mca.plaud
bun scripts/setup-oauth.ts --env pre
cd /opt/teros
bun packages/backend/src/scripts/sync-mcas.ts
# restart backend (requires admin approval)
```

The script:
1. Reads `manifest.json` for OAuth endpoints.
2. Calls `POST https://mcp.plaud.ai/register` with a public PKCE client payload.
3. Writes the returned `client_id` to `.secrets/mcas/mca.plaud/credentials.json`.

No `CLIENT_SECRET` is needed — we are a public client (`token_endpoint_auth_method: none`).

## Tools

| Tool | Maps to MCP tool | Description |
|---|---|---|
| `list-notes` | `list_files` | List recordings |
| `get-note` | `get_file` + `get_note` | Recording details, transcript, AI summary |
| `get-transcript` | `get_transcript` | Raw transcript segments with speaker labels |
| `search-notes` | `list_files` + client-side filter | Search by keyword/date |
| `list-tags` | `list_files` + client-side extraction | Tags/folders (fallback until a dedicated tool exists) |
| `get-current-user` | `get_current_user` | Current user profile |
| `download-recording` | `get_file` | Audio URL (defensive mapping pending real tool validation) |
| `-health-check` | `list_files` or `get_current_user` | Connectivity check |

## Architecture

```
Teros UI  →  Teros Backend (mca-oauth.ts)  →  Plaud OAuth
                │
                └── generates PKCE challenge + state
                └── stores code_verifier in DB
                └── builds authorize URL with client_id
                └── exchanges code → tokens at /token
                └── stores ACCESS_TOKEN / REFRESH_TOKEN / EXPIRY_DATE

MCA (mca.plaud)
  └── reads ACCESS_TOKEN from user secrets via getPlaudSecrets()
  └── passes token to MCP SDK StreamableHTTPClientTransport
  └── calls Plaud MCP tools (list_files, get_file, etc.)
```

The MCA **does not** implement its own OAuth flow, PKCE, or token refresh. It only consumes tokens provided by the Teros backend.

## Development

```bash
cd /opt/teros/mcas/mca.plaud
bun test
```

Regenerate `tools.json` after changing tool definitions:

```bash
cd /opt/teros
bun scripts/generate-mca-tools.ts mca.plaud
```
