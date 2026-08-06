# mca.brevo

Brevo (formerly Sendinblue) email marketing integration for Teros.

## Auth

Per-user **API key** (header `api-key`, NOT Bearer). Each user adds their own
`BREVO_API_KEY` (Brevo → Settings → SMTP & API → API Keys). Runs in a
`per-app` HTTP container so keys never leak between users.

## Tools

| Tool | Brevo endpoint | Notes |
|------|----------------|-------|
| `send-transactional-email` | `POST /smtp/email` | Sender must be a **verified** sender/domain. Provide `htmlContent` and/or `textContent`. |
| `list-contacts` | `GET /contacts` | Pagination via `limit` (1-1000) / `offset`. |
| `create-contact` | `POST /contacts` | `updateEnabled:true` updates an existing contact instead of erroring. |
| `get-contact` | `GET /contacts/{identifier}` | By email or id. |
| `update-contact` | `PUT /contacts/{identifier}` | Attributes + `listIds` (add) / `unlinkListIds` (remove). |
| `delete-contact` | `DELETE /contacts/{identifier}` | **Irreversible** — removes the contact and its history. |
| `add-contact-to-list` | `POST /contacts/lists/{id}/contacts/add` | By `emails[]` / `ids[]`. Reversible. |
| `remove-contact-from-list` | `POST /contacts/lists/{id}/contacts/remove` | By `emails[]` / `ids[]`. Reversible. |
| `import-contacts` | `POST /contacts/import` | Bulk import via `jsonBody[]` **xor** `fileUrl`; `listIds` **required**. Async → `processId`. |
| `list-attributes` | `GET /contacts/attributes` | Valid attribute keys (FIRSTNAME, custom fields…) for create/update/import. |
| `list-segments` | `GET /contacts/segments` | Saved contact filters; ids usable as `recipients.segmentIds` in a campaign. |
| `list-folders` | `GET /contacts/folders` | Folders group lists; needed to discover a `folderId` for `create-list`. |
| `list-lists` | `GET /contacts/lists` | Pagination via `limit` (1-50) / `offset`. |
| `create-list` | `POST /contacts/lists` | `name` + `folderId` both **required** — a list always lives in a folder. |
| `list-email-templates` | `GET /smtp/templates` | Optional `templateStatus` (true=active, false=inactive, omit=all). |
| `create-email-template` | `POST /smtp/templates` | `sender` is `{email}` **xor** `{id}`; `htmlContent` (≥10 chars) **or** `htmlUrl`. Inactive by default. |
| `list-email-campaigns` | `GET /emailCampaigns` | Filter by `type` / `status`. |
| `get-email-campaign` | `GET /emailCampaigns/{id}` | Detail of one campaign. |
| `create-email-campaign` | `POST /emailCampaigns` | Content = exactly one of `htmlContent` (≥10) / `htmlUrl` / `templateId`. Draft unless `scheduledAt` (which requires `recipients.listIds`). |
| `send-test-email` | `POST /emailCampaigns/{id}/sendTest` | **Irreversible** — sends real test emails to given addresses. |
| `send-email-campaign` | `POST /emailCampaigns/{id}/sendNow` | **Irreversible** — sends to all recipients, no undo. |
| `get-email-event-report` | `GET /smtp/statistics/events` | Per-message delivery events. Timeframe `days` **xor** `startDate`+`endDate`; filters by email/event/messageId/templateId. |
| `get-aggregated-smtp-report` | `GET /smtp/statistics/aggregatedReport` | Totals (requests, delivered, opens, clicks, bounces…) over a timeframe; optional `tag`. |
| `-health-check` | `GET /account` | Validates the API key (401 → `AUTH_INVALID`). |

> **Not supported by the Brevo API:** creating/configuring *automation workflows*
> is UI-only (no REST endpoint). The API can only trigger existing automations
> via events, so no MCA tool can create them.

## Architecture

- `src/lib/brevo-client.ts` — `fetch` wrapper, `api-key` header, GET-only retry
  on 429/5xx (POST/PUT/DELETE never retried — no idempotency key).
- `src/lib/_brevo-error.ts` — status → `(code, action)` classifier. Thrown
  `BrevoApiError.message` is prefixed `[CODE]` (e.g. `[AUTH_INVALID]`,
  `[RATE_LIMITED]`, `[BAD_REQUEST]`); the literal upstream text is preserved in
  `upstreamMessage`.
- `src/tools/_helpers.ts` — pure boundary validation + request-body
  construction + response shaping (unit-tested with exact payloads).
- `src/tools/*.ts` — thin `ToolConfig` wrappers (validate → build → request → shape).

Handlers return **plain data** (ids + resolved sender/recipients), never UI
strings — the frontend renderer composes the sentence.

## Tests

```bash
bun test mcas/mca.brevo/
```

Covers error classification + `[CODE]` prefix, boundary validation, and exact
request-body construction.
