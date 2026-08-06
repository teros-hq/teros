# Netlify MCA

Deploy static sites (HTML/CSS/JS generated in the workspace) to [Netlify](https://www.netlify.com) and get back the public URL. Uses Netlify's **file-digest REST API** (no CLI, no ZIP) with a per-user Personal Access Token.

## Configuration

### User secret

This MCA authenticates per user — each user supplies their own Netlify Personal Access Token, so no quota is shared between users.

| Secret | Description |
|--------|-------------|
| `NETLIFY_TOKEN` | A Netlify Personal Access Token. Create one at **User settings → Applications → Personal access tokens** (https://app.netlify.com/user/applications). |

The token is sent as `Authorization: Bearer <NETLIFY_TOKEN>` against `https://api.netlify.com/api/v1`.

## Tools

### `deploy-site`

Deploy a directory under `/workspace` to Netlify and return the public URL.

> ⚠️ **Everything under `dir` becomes PUBLIC.** The deployed files are served on the open internet at the returned URL — never point `dir` at a directory that contains secrets (`.env`), credentials, or private data. The tool requires a permission grant (`destructiveHint`) and **refuses to deploy the entire workspace root** unless you pass `allowWorkspaceRoot: true`.

```json
{
  "dir": "site",
  "siteName": "my-demo-site",
  "draft": false
}
```

- `dir` (required): directory relative to `/workspace` to deploy (must contain an `index.html`). Its **entire contents become public** — point it at a build-output subdirectory, not the workspace root.
- `siteId` (optional): deploy to an existing site by id (takes precedence over `siteName`).
- `siteName` (optional): deploy to the site with this name, creating it if it doesn't exist.
- `draft` (optional, default `false`): create a preview deploy instead of publishing to production.
- `allowWorkspaceRoot` (optional, default `false`): explicit confirmation required to deploy `dir: "."` (the whole workspace root). Without it, a root deploy is rejected with `[ROOT_DEPLOY_BLOCKED]`.

Returns `{ url, deployId, state, siteId, siteName, draft, fileCount, uploadedCount }`.

**How it works:** walks the directory (jailed to `/workspace`), computes a lowercase-hex SHA1 of every file, declares the digest via `POST /sites/{id}/deploys`, uploads only the files Netlify reports as missing (`required`), then polls `GET /deploys/{id}` until the deploy reaches `ready` and returns its `ssl_url`.

### `list-sites`

List the Netlify sites reachable with the token.

```json
{}
```

Returns `{ sites: [{ id, name, url, ssl_url }] }`.

### `get-deploy-status`

Check the state of a specific deploy.

```json
{
  "siteId": "abc123",
  "deployId": "def456"
}
```

Returns `{ state, url, errorMessage }`.

### `-health-check`

Internal SDK contract tool. Validates `NETLIFY_TOKEN` against `GET /user`.

## Security

- **Public exposure is the main risk:** a deploy publishes its directory to a public URL. `deploy-site` is gated on a permission grant (`destructiveHint: true`, so it is never auto-allowed) and refuses to publish the workspace root unless `allowWorkspaceRoot: true` is set — guarding against prompt-injection that would otherwise leak `.env`/PII.
- **Path jail:** the deploy directory is resolved through a realpath-based jail (`src/lib/path-jail.ts`) so `..`, absolute paths, and symlinks cannot ship files from outside `/workspace`. Files are read with `O_NOFOLLOW` so a symlink swapped in after validation (TOCTOU) cannot exfiltrate its target.
- **SSRF-safe HTTP:** every API call goes through `safeFetch` from `@teros/mca-sdk`, which rejects private/internal addresses and re-validates each redirect hop.
- **Per-user credentials:** `containerMode: per-app` keeps each user's token in its own container.

## Rate limits

Netlify allows ~3 deploys/min per account. Each user authenticates with their own PAT, so limits are not shared across Teros users.

## Notes

- **Icon:** `static/icon.png` is a placeholder copied from `mca.teros.webfetch` — replace with the official Netlify logo before release.
- **No build step:** this MCA deploys pre-built static assets. It does not run a build (no `package.json` install / framework build); generate the site in the workspace first, then deploy the output directory.

## Development

```bash
bun test mcas/mca.netlify/
```
