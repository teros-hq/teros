# Slack MCA for Teros

Full Slack workspace integration for the Teros platform.

## Features

- **Channels**: List, get details, create, archive, join, invite users
- **Messages**: Send to channels/DMs/threads, list history, thread replies
- **Reactions**: Add and remove emoji reactions
- **Users**: List workspace members, get profiles by ID or email, check presence
- **Files**: Upload to channels/threads, list workspace files
- **Search**: Search messages and files across the workspace
- **Team Info**: Get workspace details

## Authentication

OAuth 2.0 with the following scopes:

- `channels:read`, `channels:manage`, `channels:join`
- `chat:write`, `chat:write.public`, `chat:write.customize`
- `files:read`, `files:write`
- `groups:read`, `groups:write`
- `im:read`, `im:write`
- `mpim:read`, `mpim:write`
- `reactions:read`, `reactions:write`
- `search:read`
- `team:read`
- `users:read`, `users:read.email`, `users.profile:read`
- `usergroups:read`

## Architecture

- Uses `@slack/web-api` v7.8.0 with built-in rate limiting and retry logic
- HTTP transport via `McaServer` from `@teros/mca-sdk`
- Session caching by access token
- Comprehensive error handling for rate limits, auth errors, missing scopes, etc.

## Tools (20 total)

| Tool | Description |
|------|-------------|
| `-health-check` | Verify credentials and API connectivity |
| `list-channels` | List public/private channels with pagination |
| `get-channel` | Get detailed channel info by ID |
| `create-channel` | Create a new public or private channel |
| `archive-channel` | Archive (close) a channel |
| `join-channel` | Join a public channel |
| `invite-to-channel` | Invite users to a channel |
| `list-users` | List workspace users with pagination |
| `get-user` | Get user profile by ID or email |
| `get-user-presence` | Check user's online status |
| `send-message` | Send message to channel/DM with blocks support |
| `send-thread-reply` | Reply in a message thread |
| `list-messages` | List channel history or thread replies |
| `add-reaction` | Add emoji reaction to a message |
| `remove-reaction` | Remove emoji reaction from a message |
| `upload-file` | Upload and share files to channels/threads |
| `list-files` | List workspace files with filters |
| `search-messages` | Search messages across workspace |
| `search-files` | Search files across workspace |
| `get-team-info` | Get workspace information |

## Rate Limiting

The `@slack/web-api` client is configured with:
- 3 retries with exponential backoff (factor 2)
- Min timeout: 1s, Max timeout: 30s
- Randomized jitter

## Error Handling

All tools handle common Slack errors:
- Rate limits → retry suggestion
- Invalid auth → reconnection prompt
- Missing scopes → permission upgrade prompt
- Channel/user not found → validation error
- Archived channels → unarchive suggestion
