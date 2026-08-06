# mca.teros.http — Generic HTTP Request

A single tool, `http-request`, that lets an agent call **any public REST API** —
useful for services without a dedicated MCA (Hunter.io, Brevo, Make.com webhooks,
Apollo, Clearbit, NeverBounce, or anything else with a REST endpoint).

## Why

Building a dedicated MCA per service is overkill when all you need is a couple of
REST calls. This MCA is the universal escape hatch: give it a method, a URL,
headers, query and body, and it makes the request — safely.

## Secrets — never paste a key in clear

Save each API key **once** in the app's settings (they are stored encrypted,
per user) and reference it with a `{{PLACEHOLDER}}` in the `url`, a `query`
value, or a `header` value. The placeholder is resolved inside the container,
just before the request, so the real key **never reaches the model's context or
the conversation history**.

Pre-declared secret slots: `HUNTER_API_KEY`, `BREVO_API_KEY`, `MAKE_WEBHOOK_TOKEN`,
`APOLLO_API_KEY`, `CLEARBIT_API_KEY`, `NEVERBOUNCE_API_KEY`, plus `CUSTOM_TOKEN_1`
and `CUSTOM_TOKEN_2` for anything else. Fill in only the ones you use.

## Examples

**Hunter.io — domain search** (key goes in the query string):
```json
{
  "method": "GET",
  "url": "https://api.hunter.io/v2/domain-search",
  "query": { "domain": "stripe.com", "api_key": "{{HUNTER_API_KEY}}" }
}
```

**Brevo — transactional email** (key goes in a custom header):
```json
{
  "method": "POST",
  "url": "https://api.brevo.com/v3/smtp/email",
  "headers": { "api-key": "{{BREVO_API_KEY}}" },
  "body": "{\"sender\":{\"email\":\"you@example.com\"},\"to\":[{\"email\":\"x@y.com\"}],\"subject\":\"Hi\",\"htmlContent\":\"<p>Hi</p>\"}"
}
```

**Make.com — trigger a webhook** (token is part of the URL):
```json
{
  "method": "POST",
  "url": "https://hook.eu1.make.com/{{MAKE_WEBHOOK_TOKEN}}",
  "body": "{\"event\":\"lead_captured\",\"email\":\"x@y.com\"}"
}
```

## Safety

- **SSRF-safe**: powered by `safeFetch` from `@teros/mca-sdk` — DNS is resolved
  and any private / loopback / link-local / cloud-metadata address is rejected,
  and every redirect hop is re-validated.
- Only `http`/`https`. In production, `http://` is **refused for requests that
  carry secrets** (no plaintext credential transit); use `https://`.
- Response capped at 5 MB — the body is read incrementally and the request is
  **aborted** (`[RESPONSE_TOO_LARGE]`) the moment it crosses the cap, so a
  missing or spoofed `content-length` can't blow up memory.
- Timeout 1–120 s (default 30 s); a non-numeric `timeoutMs` falls back to 30 s.
- Secrets are injected only into the outbound request and **never returned**:
  credential-looking headers/query keys are masked by name, and any resolved
  secret value that an endpoint reflects back (body, headers, errors) is replaced
  with `***` before the result reaches the model.
- Placeholders are strict: a `{{ name }}` that isn't a configured secret fails
  loud (`[MISSING_SECRET]`), and a malformed reference (e.g. `{{ my-key }}`)
  fails loud (`[BAD_PLACEHOLDER]`) instead of being sent verbatim.

## Threat model — exfiltration is possible by design

This tool is a **general egress primitive**: the agent picks the destination host
*and* the headers/body, and a stored secret is **not bound to any host**. That
combination means a successful **prompt injection** can direct the agent to send a
saved key (e.g. `{{HUNTER_API_KEY}}`) to an attacker-controlled host. The guards
above bound the blast radius but do **not** prevent this:

- The SSRF guard blocks *internal* targets, not *arbitrary public* ones — sending
  a key to `https://attacker.example` is exactly what the tool is for.
- Secret values are kept out of the model's context, but they still travel to
  whatever host the (possibly manipulated) request names.

Mitigations and guidance:

- Only store **low-sensitivity, single-purpose** keys here; never a key that also
  grants access to unrelated systems.
- This tool is **not** marked read-only (`readOnlyHint: false`), so the permission
  gate asks for confirmation before each call — review the destination host on
  approval.
- Prefer a **dedicated MCA** (scoped auth, host-locked) for any high-value
  provider; reserve `http-request` for low-stakes or one-off REST calls.
