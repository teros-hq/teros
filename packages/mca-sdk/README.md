# @teros/mca-sdk

SDK for building MCAs (Model Context Apps) on the Teros platform.

Provides:
- **`McaServer`** — define tools with a simple API, auto-detects transport (HTTP or stdio/MCP)
- **Backend client** — communicate with the Teros backend via HTTP callbacks
- **Health checks** — standardized health reporting (`HealthCheckBuilder`)
- **Secrets on-demand** — fetch system/user secrets from the backend
- **Storage APIs** — `ctx.volume` (files), `ctx.storage` (documents), `ctx.objects` (binary blobs)
- **Resilience helpers** — `withRetry`, `withTimeout`, `spawnWithAbort`
- **SSRF guard** — `assertPublicUrl`, `safeFetch` for MCAs reaching caller-supplied URLs
- **Media persistence** — `persistExternalMedia`, `persistExternalMediaOutput` (see below)

---

## Media persistence — the objects-first standard

**Every MCA that produces media (images, video, audio, files) MUST return
internal object-storage URLs — never localhost paths or third-party ephemeral
URLs.** This is a platform-wide rule (Pablo, 2026-10-20).

Third-party URLs expire (Replicate's CDN has a 1h TTL, most providers are
similar). Localhost paths die with the MCA process. The agent receiving the
tool result has no way to know this and will happily pass a dead URL to the
user. The only safe pattern is:

1. Download the media from the external URL.
2. Persist it into `ctx.objects` (the platform's per-installation blob store).
3. Return the **internal permanent URL** from `ctx.objects.put()`.

The `media-persistence` module implements this pattern. Use it.

### `persistExternalMedia(url, ctx, options?)`

Persist a single external URL. Returns `{ url, objectId, warning? }`.

```typescript
import { persistExternalMedia } from '@teros/mca-sdk';

server.tool('generate-image', {
  // ...
  handler: async (args, context) => {
    const externalUrl = await callSomeImageApi(args.prompt);
    const persisted = await persistExternalMedia(externalUrl, context, {
      source: 'my-image-api',
      metadata: { prompt: args.prompt },
    });
    if (persisted.warning) {
      // File was too large — we returned the original URL with a warning.
      // Surface this to the caller.
      return { url: persisted.url, warning: persisted.warning };
    }
    return { url: persisted.url, objectId: persisted.objectId };
  },
});
```

**Behavior:**
- Sends a `HEAD` request first to check `content-length`. If it exceeds
  `maxSizeBytes` (default **50MB**), returns the original URL with a
  `warning` — no download, no `objects.put` call.
- If `HEAD` fails or is unsupported, proceeds with `GET` and re-checks the
  actual body size after download.
- On `GET` non-2xx, **throws** — the media is gone, callers should treat
  this as a tool failure (not a warning).
- Stores metadata on the object: `source`, `externalUrl`, plus anything in
  `options.metadata`.

### `persistExternalMediaOutput(output, ctx, options?)`

Persist an arbitrary tool output value. Handles the three shapes that media
APIs typically return:

- **Single URL string** → returns the internal URL string.
- **Array of URLs (and/or other items)** → persists each URL, keeps non-URL
  items (text, numbers) as-is. Returns an array of the same shape.
- **Anything else** (text, data URIs, structured objects) → returned as-is,
  no network calls.

Returns `{ output, objectIds, warnings, externalUrls, internalUrls }`. The
`externalUrls` / `internalUrls` pair is parallel — index `i` in
`internalUrls` is the permanent URL for `externalUrls[i]`. Use this to build
a cache mapping if your MCA polls the same resource repeatedly (see
`mca.replicate` for an example with `ctx.storage`).

```typescript
import { persistExternalMediaOutput } from '@teros/mca-sdk';

const result = await persistExternalMediaOutput(apiResponse.output, context, {
  source: 'elevenlabs',
  metadata: { model: 'eleven_multilingual_v2' },
});
// result.output has the same shape as apiResponse.output but with internal URLs
```

### Options

```typescript
interface PersistExternalMediaOptions {
  /** Max size in bytes. Default: 50MB. Oversized files return original URL + warning. */
  maxSizeBytes?: number;

  /** Source identifier stored in object metadata (e.g. 'replicate', 'elevenlabs'). */
  source?: string;

  /** Extra metadata stored alongside the object. */
  metadata?: Record<string, string>;

  /** Fallback content-type if the server doesn't send one. Default: 'application/octet-stream'. */
  defaultContentType?: string;

  /** Fetch override for tests. Default: global fetch. */
  fetchImpl?: typeof fetch;
}
```

### `isExternalMediaUrl(value)`

Type guard: returns `true` if `value` is a string starting with `http://` or
`https://`. Useful for pre-filtering before calling `persistExternalMedia`.

---

## Quickstart

```typescript
import { McaServer } from '@teros/mca-sdk';

const server = new McaServer({
  id: 'mca.example.tool',
  name: 'Example Tool',
  version: '1.0.0',
});

server.tool('hello', {
  description: 'Say hello',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  },
  handler: async (args, context) => {
    const secrets = await context.getSystemSecrets();
    return `Hello, ${args.name}!`;
  },
});

server.start();
```

See `mcas/` in the monorepo for real-world examples (`mca.replicate`,
`mca.elevenlabs`, `mca.playwright`, etc.).
