# Teros Terminal — Even Realities G2 Terminal Mode Provider

## What this is

An implementation of the Even Terminal provider interface (9 methods) that lets the Even Realities G2 smart glasses talk to **any Teros agent** through the official Terminal Mode.

The Even phone app connects to the Teros backend as if it were the official `@evenrealities/even-terminal` CLI. The backend serves the same `/api/*` + SSE contract, so the app cannot tell the difference.

## Architecture

```
G2 (display) ◄─BLE─► Even Phone App ◄─SSE/REST─► Teros Backend (:3000)
                                                         │
                                                    terminal-routes.ts
                                                         │
                                                    terminal-provider.ts (9 methods)
                                                         │
                                                    wakeUpCallback → Agent
```

## Files

| File | Purpose |
|------|---------|
| `terminal-bus.ts` | Per-session SSE ring buffer + client registry |
| `terminal-provider.ts` | The 9-method provider interface (the core) |
| `terminal-routes.ts` | HTTP handler mapping `/api/*` to provider methods |
| `terminal-server.ts` | Standalone CLI server (for testing without full backend) |

## The 9 Provider Methods

```typescript
{
  listSessions,       // 1. List Teros channels for the token's agent
  getSessionStatus,   // 2. idle / busy / awaiting
  getInfo,            // 3. Agent info (name, model, version)
  getHistory,         // 4. Channel message history
  prompt,             // 5. Send a message to the agent
  respondPermission,  // 6. Respond to tool permission request
  respondQuestion,    // 7. Respond to user question
  interrupt,          // 8. Cancel running turn
  getStatus,          // 9. Synchronous status check
}
```

## Security

- **Auth**: API tokens (`tak_` + 192-bit random) stored in MongoDB `api_tokens`
- **Token creation**: `POST /g2/tokens` requires user session auth
- **Chat/Terminal**: Uses G2 token via `?token=` query param or `Authorization: Bearer`
- **CSRF-exempt**: Correct — uses Bearer token, not session cookies
- **Billing gate**: Checked before agent dispatch
- **Provider label**: Presents as `"claude"` on the wire (the Even app filters by provider)

## Setup

### 1. Create a G2 token

```bash
curl -X POST http://localhost:3000/g2/tokens \
  -H "Authorization: Bearer <your-session-token>" \
  -H "Content-Type: application/json" \
  -d '{"agentId": "agent_xxx", "label": "My G2"}'
# → {"token": "g2_xxxxxxxx...", "agentId": "...", ...}
```

### 2. Connect the Even app

Open the Even Realities app on your phone, enable Terminal Mode, and enter:

```
http://<your-server-ip>:3000/api/info?token=g2_xxxxxxxx...&defaultProvider=claude
```

Or scan a QR code containing that URL.

### 3. Start chatting from the G2

The Even app will connect to `/api/events` (SSE) and send prompts via `/api/prompt`. Responses stream back as `text_delta` events.

## Event Translation

| Teros Event | Even Terminal Event |
|-------------|---------------------|
| `message_chunk` + `text_chunk` | `text_delta` |
| `message_chunk` + `tool_call_start` | `tool_start` |
| `message_chunk` + `tool_call_complete` | `tool_end` |
| Assistant message saved | `result` + `status: idle` |
| Tool pending permission | `permission_request` |
| Error | `error` + `status: idle` |

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | None | Health check |
| GET | `/api/events?sessionId=` | G2 token | SSE event stream |
| GET | `/api/sessions` | G2 token | List sessions |
| GET | `/api/info` | G2 token | Provider info |
| GET | `/api/status?sessionId=` | G2 token | Session status |
| GET | `/api/messages?sessionId=` | G2 token | Buffered messages |
| GET | `/api/sessions/:id/history` | G2 token | Conversation history |
| POST | `/api/prompt` | G2 token | Send a prompt |
| POST | `/api/permission-response` | G2 token | Respond to permission |
| POST | `/api/question-response` | G2 token | Respond to question |
| POST | `/api/interrupt` | G2 token | Interrupt turn |
| GET | `/api/update-check` | G2 token | Version check stub |
| GET | `/api/metrics` | G2 token | Metrics stub |
| POST | `/api/codex/ensure-app-server` | G2 token | Codex stub |
