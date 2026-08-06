# mca.whatsapp

WhatsApp integration for Teros via [WAHA](https://waha.devlike.pro/) (WhatsApp HTTP API).

---

## Architecture

This MCA runs a custom Docker image (`teros/mca-runtime-whatsapp:latest`) that bundles two processes managed by **supervisord**:

1. **WAHA** — the WhatsApp HTTP gateway (runs on internal port 3001)
2. **MCA server** — the Teros tool server (runs on port 3000, waits for WAHA to be ready before starting)

The MCA server proxies tool calls to WAHA's REST API.

### Docker image

```
docker/mca-runtime-whatsapp/
├── Dockerfile
├── supervisord.conf       # Manages WAHA + MCA server processes
└── entrypoint.sh
```

Key supervisord env vars passed to WAHA:
- `PORT` — WAHA internal port (3001)
- `WAHA_LOCAL_STORE_BASE_DIR=/app-data` — session persistence directory (bind-mounted from workspace)

### Session persistence

Sessions are stored in the user's workspace volume via `appDataMount: true`:

```
Host:      workspaceHostPath/.apps/whatsapp/   →   Container: /app-data
```

WAHA writes its session data (SQLite DB, credentials) to `/app-data`, which maps to the user's persistent workspace volume. This means sessions survive container restarts.

> **Note:** `WAHA_LOCAL_STORE_BASE_DIR` must be passed to the WAHA process via supervisord's `environment=` directive — it is NOT inherited automatically from the container env.

**Previous (wrong) approach:** sessions were hardcoded to `/opt/teros/.sessions/mca.whatsapp/waha` — a path inside the repo root, shared across all users. Fixed in commit `f2b32427`.

---

## Auth

`auth: false` — no user secrets required. The WAHA API key is a system-level secret. `systemEnvironment.WAHA_API_KEY` in `manifest.json` is a `${SECRET_MCA_WAHA_API_KEY}` placeholder — the real value lives in `.secrets/mcas/mca.whatsapp/credentials.json` (gitignored; copy `credentials.example.json` and fill it in) and is resolved at container spawn time (`mca-manager.spawn-impl.ts`, interpolation covered by `mca-spawn-impl.test.ts`).

`WHATSAPP_PROXY_SERVER*` (Bright Data residential proxy, used to avoid WhatsApp flagging the WAHA session) is **optional** — a self-hoster without a Bright Data account can leave those three keys out of `credentials.json`; WAHA connects directly and works the same, just without proxy egress. Users link their WhatsApp account **always with a numeric pairing code** using the `start-session` and `request-pairing-code` tools. QR-based authentication is not supported (the former `get-qr` tool was removed); the WAHA session state `SCAN_QR_CODE` simply means "waiting to be linked".

> **Why no `userSecrets`:** a previous version included `WAHA_SESSION_NAME` as a user secret, which caused the app to always appear as "not connected" in the UI (the AuthPanel expected the user to fill it in). Removed — the session name is always `"default"` and is hardcoded in the MCA source.

---

## Tools (28)

| Tool | Description |
|---|---|
| `-health-check` | Verifies WAHA connectivity and lists active sessions |
| `session-status` | Get current session status |
| `start-session` | Start/create a session; auto-restarts if FAILED |
| `stop-session` | Stop session without deleting it |
| `request-pairing-code` | Get numeric pairing code to link the device (only supported auth method) |
| `send-text` | Send a text message |
| `send-image` | Send an image from a public URL |
| `send-document` | Send a file/document from a public URL or /workspace/ path |
| `get-messages` | Get recent messages from a chat (with filters, pagination) |
| `get-chats` | List all chats in the session |
| `get-contacts` | List all contacts |
| `check-number` | Check if a phone number has WhatsApp |
| `get-labels` | List labels (WhatsApp Business only) |
| `get-chat-labels` | Get labels for a specific chat |
| `put-chat-labels` | Set/replace labels for a chat |
| `search-chats` | Search chats by name or phone number |
| `download-media` | Download media from a message to /workspace/ |
| `reaction` | React to a message with an emoji |
| `read-messages` | Mark messages in a chat as read (all or specific IDs) |
| `mark-unread` | Mark a chat as unread (blue dot indicator) |
| `get-profile` | Get the current account's profile (name, picture, About) |
| `set-profile-name` | Change the profile display name |
| `set-profile-status` | Change the "About" status text |
| `set-profile-picture` | Set the profile picture from a public URL |
| `delete-profile-picture` | Delete the current profile picture |
| `get-contact-profile-picture` | Get a contact's profile picture URL |
| `search-contacts` | Search contacts by name or phone number |
| `get-unread-chats` | List chats with unread messages |

---

## Known gaps (vs WAHA OpenAPI spec)

### Messages
- `send-voice` — send voice note
- `send-video` — send video
- `forward-message` — forward a message
- `send-seen` — mark messages as read
- `start-typing` / `stop-typing` — typing indicator
- `send-poll` — send a poll
- `send-location` — send a location
- `send-contact` — send a contact vCard
- `edit-message` — edit a sent message
- `delete-message` — delete a message
- `pin-message` / `unpin-message` — pin/unpin a message

### Chats
- `get-chats-overview` — chats overview with picture + last message
- `delete-chat` — delete a chat
- `get-chat-picture` — get chat/group picture
- `read-messages` — mark messages as read ✅
- `mark-unread` — mark chat as unread ✅
- `archive-chat` / `unarchive-chat`
- `get-message-by-id` — get a specific message by ID
- `get-chats-by-label` — get chats filtered by label

### Profile
- `get-profile` — get my profile (name, picture, status) ✅
- `set-profile-name` ✅
- `set-profile-status` ✅
- `set-profile-picture` ✅
- `delete-profile-picture` ✅
- `get-contact-profile-picture` — get a contact's profile picture URL ✅

### Groups (none implemented)
- Create/delete group
- Add/remove participants
- Promote/demote admins
- Get invite code
- Update description/subject/picture
- Group settings (admin-only messages, etc.)

---

## Compliance status (MCA-RUNBOOK.md checklist)

| Criterion | Status | Notes |
|---|---|---|
| 1. `manifest.json` valid | ✅ | |
| 2. `@teros/mca-sdk` in package.json | ✅ | |
| 3. `tools.json` with full inputSchema | ❌ | Not generated yet |
| 4. Icon canonical | ✅ | 256×256 PNG, purple #7C3AED |
| 5. Import from `@teros/mca-sdk` | ✅ | |
| 6. Minimal constructor + per-handler secrets | ✅ | |
| 7. `-health-check` tool | ✅ | |
| 8. No startup crashes | ✅ | |
| 9. Output adapted to renderer | ❌ | No renderer yet; returns raw JSON |
| 10. Curated fields + `includeRaw` | ❌ | No `includeRaw` parameter |
| 11. Clear LLM descriptions | ✅ | |
| 12. Custom renderer (100% coverage) | ❌ | No renderer exists |
| 13. Shared primitives | ❌ | No renderer |
| 14. Loading/success/error states | ❌ | No renderer |
| 15. `structuredContent` (MCP compliance) | ❌ | Not implemented |
| 16. Pagination on list tools | ✅ | `get-chats` (limit/offset, sortBy conversationTimestamp desc), `get-contacts` (client-side, sorted by name), `get-messages` (limit/offset/sort) |
| 17. Annotations (version + stability) | ❌ | Not implemented |
| 18. Resilience (timeouts + retries) | ⚠️ | No explicit timeouts |
| 19. L1 runner pass | ✅ | |
| 20. L2 health-check | ✅ | WORKING |
| 21. Unit tests | ❌ | No tests |
| Source split (one file per tool) | ✅ | `src/tools/` (21 files) + `src/lib/` |

---

## Rebuild instructions

After modifying `supervisord.conf` or `Dockerfile`:

```bash
cd /opt/teros
docker build -f docker/mca-runtime-whatsapp/Dockerfile -t teros/mca-runtime-whatsapp:latest .
docker rm -f <container-name>
# Backend will recreate the container automatically on next tool call
```

After modifying `manifest.json` or `src/index.ts`:

```bash
# Sync manifest changes to catalog
yarn sync  # or use admin-sync tool

# Regenerate tools.json after adding/changing tools
bun scripts/generate-mca-tools.ts mca.whatsapp
```
