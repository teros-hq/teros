# Figma MCA

Access Figma design files, extract styles, components, design tokens, manage comments, audit version history, and export assets directly from your AI assistant.

## Features

- 📁 **File access**: pages, frames, top-level components (curated tree, configurable depth)
- 🧩 **Components**: list components and component sets (variant groups)
- 🎨 **Styles**: list FILL / TEXT / EFFECT / GRID styles
- 🪙 **Design tokens**: variables grouped by collection, with modes
- 📤 **Export**: PNG / JPG / SVG / PDF, scale 0.01–4
- 💬 **Comments**: read, create, reply, delete
- 🕓 **Versions**: paginated history with author and label
- 🛠 **Extract**: colors and typography as CSS, Tailwind config, or JSON

## Setup

The MCA uses **OAuth 2.0** (the previous Personal Access Token flow was replaced in v2.0.0).

### 1. Connect your Figma account

In the Teros app:

1. Open **App Settings** → **Integrations** → **Figma**.
2. Click **Connect** — you will be redirected to Figma to authorize the requested scopes.
3. On success, the access token, refresh token, and expiry are stored encrypted in your user secrets.

The MCA refreshes the token automatically when it expires (handled inline by `lib/figma-client.ts:figmaRequest`).

### 2. System secrets (admin only)

The OAuth client credentials are global, set once by an admin:

```text
.secrets/system/mca.figma/
  CLIENT_ID
  CLIENT_SECRET
```

These come from the [Figma Developer Console](https://www.figma.com/developers/apps).

### OAuth scopes requested

| Scope | Used by |
|---|---|
| `current_user:read` | health check (`/v1/me`) |
| `file_content:read` | get-file, get-node, extract-colors, extract-typography |
| `file_metadata:read` | get-file (metadata fields) |
| `file_comments:read` | get-comments |
| `file_comments:write` | create-comment, delete-comment |
| `file_versions:read` | list-file-versions |
| `library_content:read`, `library_assets:read`, `team_library_content:read` | get-components, get-component-sets, get-file-styles |
| `file_variables:read` | get-file-variables |
| `file_dev_resources:read`, `file_dev_resources:write` | reserved for follow-up tools |
| `webhooks:read`, `webhooks:write` | reserved for follow-up tools |

## Tools

All tools support an `includeRaw: boolean` parameter (default `false`). When `true`, the upstream Figma payload is returned unmodified — useful for debugging or when you need a field that was filtered by the default whitelist.

Most list / get tools also accept `fields: string[]` to pick a custom subset.

| Tool | Description |
|---|---|
| `figma_-health-check` | OAuth + `/v1/me` reachability |
| `figma_get-file` | File structure (`{ name, lastModified, version, thumbnailUrl, document, componentCount, styleCount }`). Params: `fileKey`, `depth (1-10, def 2)`, `geometry?`, `branchData?` |
| `figma_get-node` | Single node sub-tree. Params: `fileKey`, `nodeId` (accepts `1-2` or `1:2`), `depth (1-10, def 3)` |
| `figma_get-file-styles` | `{ styles: [{id,key,name,type,description}], count }` |
| `figma_get-file-variables` | `{ collections: [{id,name,modes,variables,defaultModeId}], collectionCount, variableCount }` |
| `figma_get-components` | `{ components: [{id,key,name,description,componentSetId?}], count }` |
| `figma_get-component-sets` | `{ componentSets: [{id,key,name,description}], count }` |
| `figma_export-images` | `{ images: [{nodeId,url,format,scale}], count, expiresInMinutes: 30 }`. Params: `fileKey`, `nodeIds`, `format? (png\|jpg\|svg\|pdf)`, `scale? (0.01-4)` |
| `figma_get-comments` | `{ comments: [{id,message,createdAt,user,resolved,parentId?,clientMeta?}], count }` |
| `figma_create-comment` | New comment or reply. Params: `fileKey`, `message`, `parentCommentId?`, `clientMeta? ({x,y} or {node_id})` |
| `figma_delete-comment` | Hard delete. Params: `fileKey`, `commentId`. **Not reversible.** |
| `figma_list-file-versions` | Paginated history. Params: `fileKey`, `pageSize (1-50, def 30)`, `before?` |
| `figma_extract-colors` | `{ count, output: string, format }`. Params: `fileKey`, `nodeId?`, `format? (css\|tailwind\|json)` |
| `figma_extract-typography` | `{ count, output: string, format }`. Params: `fileKey`, `format?` |

## Usage examples

### Inspect a file
```
Use figma_get-file with fileKey "ABC123xyz" and depth 3
```

### Extract colors for Tailwind
```
Use figma_extract-colors with fileKey "ABC123xyz" and format "tailwind"
```

### Export a frame as SVG
```
Use figma_export-images with fileKey "ABC123xyz", nodeIds ["1:234"], format "svg"
```

### Reply to an existing comment
```
Use figma_create-comment with fileKey "ABC123xyz", message "Looks good!", parentCommentId "comment-uuid"
```

### Audit version history
```
Use figma_list-file-versions with fileKey "ABC123xyz", pageSize 20
```

## Finding file keys and node IDs

- **File key**: the part after `/file/` or `/design/` in the Figma URL.
  - URL: `https://www.figma.com/design/ABC123xyz/My-Design` → `ABC123xyz`.
- **Node ID**: in the URL query (`?node-id=1-234`) or returned by `get-file`. Both `1-234` and `1:234` work.

## Output formats (extract tools)

### CSS

```css
:root {
  --color-1: #f24e1e;
  --color-2: #a259ff;
}
```

### Tailwind

```js
// tailwind.config.js colors
{
  "color-1": "#f24e1e",
  "color-2": "#a259ff"
}
```

### JSON

```json
["#f24e1e", "#a259ff"]
```

## Limitations

- **Project / team browsing not supported.** The endpoints `GET /v1/teams/:team_id/projects` and `GET /v1/projects/:project_id/files` require Figma "private OAuth apps" — Teros uses a public OAuth app, so the MCA works file-by-file via `fileKey`. Removed in commit `30946e72`.
- **Export URLs expire in ~30 minutes.** Pre-signed S3 links from `/v1/images`. Save assets locally if you need them long-term.
- **`get-file` document tree is curated.** The `simplifyNode` helper drops gradients, shadows, blendMode, layoutAlign, etc. to keep payloads ≤5% of raw size. Use `includeRaw: true` to opt out.

## Rate limits

Figma rate-limits per OAuth token. Errors of type `RATE_LIMITED` are returned with `action.type: "auto_retry"` — wait a minute and retry.

## Resources

- [Figma REST API documentation](https://www.figma.com/developers/api)
- [OAuth flow](https://www.figma.com/developers/api#oauth)
- [Variables guide](https://help.figma.com/hc/en-us/articles/15339657135383-Guide-to-variables-in-Figma)
- [Webhooks v2](https://www.figma.com/developers/api#webhooks-v2) (not yet exposed as MCA tools)
