# mca.google.analytics — Google Analytics 4

GA4 integration for Teros. Lets an agent **run reports**, query **realtime**
activity, inspect **metadata**, and **administer** GA4 properties and data
streams — all through the user's own Google account via OAuth2.

It wraps two Google APIs:

- **GA4 Data API** (`analyticsdata` v1beta) — reporting and realtime.
- **GA4 Admin API** (`analyticsadmin` v1beta) — accounts, properties, streams.

## Tools (13 + health-check)

### Reporting (Data API, read-only)

| Tool | What it does |
|------|--------------|
| `analytics-run-report` | Run a GA4 report (dimensions × metrics over date ranges). Dates accept ISO (`2024-01-01`) or relative (`7daysAgo`, `yesterday`, `today`). |
| `analytics-batch-run-reports` | Run up to 5 reports against the same property in one call (dashboards). |
| `analytics-run-realtime-report` | Last-30-minutes activity. |
| `analytics-get-metadata` | List every dimension/metric available for a property, including custom ones. |

### Admin — read (Admin API, read-only)

| Tool | What it does |
|------|--------------|
| `analytics-list-accounts` | List GA4 accounts the user can access. |
| `analytics-list-properties` | List properties under an account (`showDeleted` optional). |
| `analytics-get-property` | Get one property's details. |
| `analytics-list-data-streams` | List web/iOS/Android streams of a property. |
| `analytics-get-data-stream` | Get one stream's details. |

### Admin — write (Admin API)

| Tool | What it does | Annotation |
|------|--------------|------------|
| `analytics-create-property` | Create a property under an account. | — |
| `analytics-update-property` | Patch `displayName` / `timeZone` / `currencyCode` / `industryCategory`. | — |
| `analytics-delete-property` | **Soft**-delete a property (recoverable ~7 days from the GA UI). | `destructiveHint` |
| `analytics-create-data-stream` | Create a `WEB` / `ANDROID_APP` / `IOS_APP` data stream. | — |

Plus the internal `-health-check` (verifies OAuth + GA4 connectivity).

Property and account ids are accepted either bare (`123456`) or qualified
(`properties/123456`, `accounts/123456`); they are normalized server-side.

## OAuth scopes

Configured in `manifest.json` under `layers.auth` (provider `google`):

| Scope | Why |
|-------|-----|
| `https://www.googleapis.com/auth/analytics.readonly` | Reports, realtime, metadata, admin reads. |
| `https://www.googleapis.com/auth/analytics.edit` | Create/update/delete properties and streams. |
| `https://www.googleapis.com/auth/userinfo.email` | Label the connected account in tool output. |

> `analytics.edit` is **not** a superset of `analytics.readonly`: it grants the
> Admin API only. The GA4 **Data API** (`runReport` / `runRealtimeReport` /
> `getMetadata`) accepts only `analytics` or `analytics.readonly`, so
> `analytics.readonly` is required — the two scopes are not redundant.

## Secrets

This MCA uses the standard Teros OAuth split. Both system- and user-level
secrets live together in **`.secrets/mcas/mca.google.analytics/credentials.json`**.

| Kind | Keys | Set by |
|------|------|--------|
| `systemSecrets` | `CLIENT_ID`, `CLIENT_SECRET`, `REDIRECT_URIS` | Admin (Google Cloud OAuth client) |
| `userSecrets` | `ACCESS_TOKEN`, `REFRESH_TOKEN`, `EMAIL`, `EXPIRY_DATE` | OAuth flow, per user |

The client auto-refreshes the access token when it is within 60s of expiry
(or already expired) using the refresh token.

## Errors

Upstream Google errors are mapped to `[CODE]`-prefixed messages so the agent
can act on them: `[AUTH_EXPIRED]`, `[RATE_LIMITED]`, `[INSUFFICIENT_SCOPE]`,
`[FORBIDDEN]`, `[NOT_FOUND]`, `[INVALID_ARGUMENT]`, `[DEPENDENCY_UNAVAILABLE]`,
`[UNKNOWN]`. The literal upstream message is preserved after the prefix.

## Runtime

HTTP transport, `per-app` container (`runtime` in `manifest.json`). Each
installed app instance runs its own process and fetches secrets on demand from
the backend over the SDK WebSocket.

## Development

```bash
# Run the server directly (tsx)
cd mcas/mca.google.analytics && yarn start

# Unit tests (pure helpers: parsers, error mapping, report curation)
bun test mcas/mca.google.analytics/

# Type-check (requires @teros/shared + @teros/mca-sdk built)
cd mcas/mca.google.analytics && npx tsc --noEmit
```

Pure logic lives in `src/helpers.ts` (`parsePropertyName`, `parseAccountName`,
`parseStreamId`, `propertyIdOf`, `accountIdOf`, `pick`, `statusOf`,
`mapAnalyticsError`, `curateReport`, `buildReportRequest`,
`classifyAccountsProbe`) and is covered by `test/unit/`. The tool handlers in
`src/index.ts` compose those helpers around the `googleapis` clients —
`buildReportRequest` is shared by run-report, run-realtime-report, and each
sub-request of batch-run-reports so all three normalize identically.
