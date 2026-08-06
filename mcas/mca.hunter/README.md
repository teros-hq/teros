# mca.hunter — Hunter.io email finder

Find professional email addresses, guess a person's email from their name, and
verify deliverability via the [Hunter.io](https://hunter.io) API.

## Tools

| Tool | What it does | Returns |
|------|--------------|---------|
| `domain-search` | Find emails for a company `domain` (paginated via `limit`/`offset`). | `{ domain, organization, pattern, total, emails[] }` |
| `email-finder` | Guess a person's email from `domain` + `first_name` + `last_name`. | `{ email, score, domain, firstName, lastName, position, … }` |
| `email-verifier` | Verify whether an `email` is deliverable. | `{ email, status, result, score, … }` |
| `-health-check` | Validates the API key via `GET /account` (no credits spent). | `{ status, issues?, version?, uptime? }` |

## Auth

Per-user API key. Add `HUNTER_API_KEY` in the app's user secrets — get one at
[hunter.io/api-keys](https://hunter.io/api-keys). The key is sent in the
`X-API-KEY` HTTP header (kept out of URLs, logs and referrers — CWE-598).

## Quota

The Hunter **free tier** grants a limited monthly allowance (50 credits/month
at the time of writing — see [hunter.io/pricing](https://hunter.io/pricing) for
the current quota). `domain-search`, `email-finder` and `email-verifier` each
consume credits; `-health-check` does not. When the monthly limit is hit, tools
fail with `[QUOTA_EXCEEDED]` (HTTP 429); transient rate limiting surfaces as
`[RATE_LIMITED]` (HTTP 403) and is retried automatically.

> Tip: passing `api_key=test-api-key` to Hunter validates request parameters
> without spending credits — useful for smoke-testing argument shapes.

## Error codes

Errors are prefixed with a bracketed code so the agent can react:
`[AUTH_INVALID]` (bad/missing key), `[RATE_LIMITED]` (transient — retried on
GET), `[QUOTA_EXCEEDED]` (monthly limit), `[BAD_REQUEST]` (invalid args),
`[NOT_FOUND]`, `[DEPENDENCY_UNAVAILABLE]`.
