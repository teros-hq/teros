# mca.make — Make.com automation

Trigger Make.com scenarios via webhooks and manage scenarios through the account API.

## Tools

| Tool | Auth | Description |
|------|------|-------------|
| `trigger-webhook` | none | POST a JSON payload to a Make webhook URL (`https://hook.<region>.make.com/<token>`). The host is validated against `*.make.com` (SSRF guard). |
| `list-scenarios` | `MAKE_API_TOKEN` | List the account's scenarios. Optional `teamId` / `limit`. |
| `run-scenario` | `MAKE_API_TOKEN` | Run a scenario on demand by id. Optional `data` / `responsive`. |
| `create-scenario` | `MAKE_API_TOKEN` | Create a new scenario. `blueprint` is accepted as a JSON object and serialized internally. Optional `folderId`, `scheduling`, `confirmed`, `basedon`. |
| `get-scenario` | `MAKE_API_TOKEN` | Read a single scenario by id. |
| `get-scenario-blueprint` | `MAKE_API_TOKEN` | Read the blueprint of a scenario by id. Returns the parsed JSON object when possible. |
| `update-scenario` | `MAKE_API_TOKEN` | Update a scenario by id. Supports `name`, `blueprint` (JSON object), `scheduling`, `folderId`. |
| `delete-scenario` | `MAKE_API_TOKEN` | Delete a scenario by id. Irreversible. |
| `clone-scenario` | `MAKE_API_TOKEN` | Clone an existing scenario. Optional new `name` / `folderId`. |
| `start-scenario` | `MAKE_API_TOKEN` | Activate a scenario by id. |
| `stop-scenario` | `MAKE_API_TOKEN` | Pause a scenario by id. |
| `-health-check` | — | Healthy in webhook-only mode; validates the token against `GET /users/me` when one is configured. |

## Secrets (user)

- `MAKE_API_TOKEN` *(optional)* — Make account API token. Only needed for account API tools; the webhook trigger works without it.
- `MAKE_REGION` *(optional, default `eu1`)* — one of `eu1`, `eu2`, `us1`, `us2`. Selects the account API base (`https://<region>.make.com/api/v2`).

## Scopes

For full access to the v2.0 scenario management tools, create a token with these scopes:

- `scenarios:read`
- `scenarios:write`
- `teams:read`
- `organizations:read`

## Notes

- **Security**: `trigger-webhook` rejects any URL whose host is not `*.make.com` (or any non-https protocol) with `[BAD_REQUEST]`. The tokenized webhook URL is never echoed in errors — only the host is surfaced.
- **Retries**: account GETs retry transient 429/5xx with exponential backoff; POST/PATCH/DELETE (webhook trigger, run-scenario, create/update/delete/clone/start/stop) are executed exactly once.
- **Blueprints**: pass `blueprint` as a normal JSON object, not as an escaped string. The tool serializes it to the string format Make expects.
- **Plan requirement**: The Make account API (used by all scenario management tools except `trigger-webhook`) requires a Make Core plan or higher. The Free plan does not include API access, even with a valid API key. Rate limits: Core 60 req/min, Pro 120, Teams 240, Enterprise 1,000.
- Errors are prefixed with `[CODE]` (`[AUTH_REQUIRED]`, `[RATE_LIMITED]`, `[NOT_FOUND]`, …) so the agent can react appropriately.
