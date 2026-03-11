# MCA Notion Migration to the New System

## Status: ✅ Completed

**Migration date:** 2026-01-10

## Tasks

### Project structure
- [x] Create folder structure (`src/`, `src/tools/`, `src/lib/`)
- [x] Update `package.json` with correct dependencies
- [x] Create `tsconfig.json`

### Manifest and configuration
- [x] Update `manifest.json` (enabled, userSecrets, runtime)

### Client library
- [x] Create `src/lib/notion-client.ts` (API client with secrets handling)
- [x] Create `src/lib/index.ts` (exports)

### Tools - Search & Pages (8)
- [x] `search.ts` - Search in workspace
- [x] `get-page.ts` - Get page by ID
- [x] `get-page-content.ts` - Get page content
- [x] `create-page.ts` - Create page
- [x] `update-page.ts` - Update page
- [x] `set-page-icon.ts` - Set page icon
- [x] `set-page-cover.ts` - Set page cover
- [x] `duplicate-page.ts` - Duplicate page

### Tools - Databases (4)
- [x] `get-database.ts` - Get database by ID
- [x] `query-database.ts` - Query database
- [x] `create-database.ts` - Create database
- [x] `update-database-schema.ts` - Update schema

### Tools - Blocks (7)
- [x] `get-block.ts` - Get block
- [x] `get-block-children.ts` - Get block children
- [x] `append-blocks.ts` - Append blocks
- [x] `update-block.ts` - Update block
- [x] `delete-block.ts` - Delete block
- [x] `create-column-layout.ts` - Create column layout
- [x] `create-advanced-blocks.ts` - Create advanced blocks

### Tools - Users (3)
- [x] `list-users.ts` - List users
- [x] `get-user.ts` - Get user
- [x] `get-me.ts` - Get bot user

### Tools - Comments (2)
- [x] `list-comments.ts` - List comments
- [x] `create-comment.ts` - Create comment

### Index and exports
- [x] Create `src/tools/index.ts` (exports for all tools)
- [x] Create `src/index.ts` (McaServer + health check + tool registration)

### Finalization
- [x] Delete old `mcp/` folder
- [x] Delete old `credentials/` folder
- [x] Run yarn install
- [x] Generate tools.json
- [x] Run admin sync
- [x] Verify in catalog

---

## Result

- **25 tools** registered (24 + health-check)
- MCA available in the productivity catalog
- Uses `@teros/mca-sdk` with HTTP transport
- Secrets via WebSocket (`context.getUserSecrets()`)

## Usage

1. Install the app from the catalog
2. Configure `API_TOKEN` with your Notion Internal Integration Token
3. Share the pages/databases you want to access with the integration

Get token: https://www.notion.so/my-integrations
