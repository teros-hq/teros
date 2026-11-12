# mca.telegram — Telegram integration (MTProto)

Full Telegram integration for Teros via **MTProto** using [teleproto](https://www.npmjs.com/package/teleproto) (maintained GramJS fork). Unlike WhatsApp (which needs the external WAHA service), the Telegram client is **embedded**: each app instance runs its own MTProto connection inside the MCA container.

## Architecture

- **Runtime**: generic `teros/mca-runtime:latest` image (no custom Dockerfile). `teleproto` is declared in `package.json` and included in the union deps baked into the image (`scripts/gen-mca-union-deps.mjs`).
- **Server**: `McaServer` from `@teros/mca-sdk`, HTTP transport, port 3000.
- **Session persistence**: the MTProto `StringSession` is stored in `/app-data/telegram-session` (the per-app volume mounted via `appDataMount: true`). Sessions survive container restarts.
- **Auth state**: the pending `phoneCodeHash` from `auth-send-code` is kept in `/app-data/auth-state.json` so the two-step flow works across calls.
- **Secrets**: `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` come from the system secret `.secrets/mcas/mca.telegram/credentials.json`, interpolated via `${SECRET_MCA_TELEGRAM_API_ID}` / `${SECRET_MCA_TELEGRAM_API_HASH}` in `manifest.json → runtime.systemEnvironment`.

## Setup (one-time, per deployment)

1. Create a Telegram API application at https://my.telegram.org/apps → copy `api_id` and `api_hash`.
2. Store them as a system secret:

   ```bash
   # .secrets/mcas/mca.telegram/credentials.json (on the host)
   {"TELEGRAM_API_ID": "123456", "TELEGRAM_API_HASH": "..."}
   ```

3. Rebuild/restart so the env vars reach the container (`${SECRET_MCA_*}` interpolation happens at spawn time).

## Linking a user account (from the agent chat)

1. `auth-send-code` with the user's phone number → Telegram sends a verification code.
2. `auth-sign-in` with the code (and the 2FA password if the account has one) → session persisted.
3. Done — real-time event forwarding activates automatically (no tool call needed).

`auth-status` reports the current link state; `auth-disconnect` closes the session and wipes the stored one.

> Telegram may deliver the code through the Telegram app itself rather than SMS. Codes are single-use and short-lived.

## Tools (16)

| Tool | Description |
| --- | --- |
| `health-check` | MTProto connectivity + link status |
| `auth-status` | Is an account linked? Profile info |
| `auth-send-code` | Step 1: send verification code |
| `auth-sign-in` | Step 2: complete sign-in (+2FA) |
| `auth-disconnect` | Unlink and wipe session |
| `list-chats` | Dialogs: private, groups, channels |
| `get-chat-history` | Read history of any chat (pagination, filter) |
| `search-messages` | Global or per-chat text search (+ author filter) |
| `send-message` | Text to any chat, reply, silent, link previews |
| `send-media` | Files/images from URL, path or base64 (voice/doc modes) |
| `download-media` | Save a message's media to `/app-data/downloads` |
| `edit-message` | Edit own messages |
| `delete-messages` | Delete up to 100 messages (revoke for everyone or self) |
| `create-group` | Create group / supergroup / channel (+ initial members) |
| `manage-members` | List / add / kick / ban / unban members |
| `mark-as-read` | Clear unread counters |

## Real-time events

Event forwarding is **native**: the container attaches its GramJS update handlers at boot (and right after `auth-sign-in`) and emits to the Teros backend (same channel as the scheduler and the Gmail watcher). No tool call is required. The backend injects `MCA_CALLBACK_URL` + `MCA_CALLBACK_TOKEN` into the container at spawn; without them (e.g. local dev against an older backend) events are counted but not delivered.

- `telegram.message.received` — a message from someone else (private, group, channel)
- `telegram.message.sent` — a message the linked account sent (from any device)
- `telegram.message.edited` — message edits
- `telegram.message.deleted` — deletions (when Telegram reports them)

Message payloads: `messageId`, `chatId`, `chatTitle`, `chatType` (user|group|supergroup|channel), `chatUsername`, `fromId`, `fromName`, `fromUsername`, `text`, `hasMedia`, `mediaType`, `isOutgoing`, `replyToMsgId`, `mentioned`, `date`. The catalog in `manifest.json` (`events[].payload`) is what `list-event-topics` shows to agents and the Automate window; `test/events-payload.test.ts` fails if the emitted object and the catalog drift apart.

## Rate limits

Telegram enforces FloodWait on aggressive usage. The client lib raises `FloodWaitError` with a `seconds` field; tool handlers surface it as `error: 'FLOOD_WAIT_X'` with the wait time. Heavy loops (bulk invites, mass history reads) should be paced by the caller.

## Development

```bash
# Typecheck the sources
cd mcas/mca.telegram && bunx tsc --noEmit -p tsconfig.json 2>/dev/null || npx tsc --noEmit

# Unit tests (bun)
bun test test/

# Regenerate tools.json after changing tool signatures (from repo root)
bun scripts/generate-mca-tools.ts mca.telegram

# Regenerate en.json i18n (from repo root)
npx tsx scripts/generate-mca-i18n.ts
```

## Files

```
mcas/mca.telegram/
├── manifest.json          # MCA definition (runtime, secrets, auth layer)
├── package.json           # deps: @teros/mca-sdk, teleproto
├── credentials.example.json
├── src/
│   ├── index.ts           # McaServer + tool registration + health check
│   ├── lib/
│   │   ├── client.ts      # MTProto client singleton, session, serializers
│   │   └── events.ts      # real-time watcher → backend.emitEvent
│   └── tools/             # one file per tool (ToolConfig pattern)
├── static/                # icon.svg, icon-color.svg, icon.png
├── i18n/                  # es.json, en.json, ko.json
└── test/                  # bun unit tests
```
