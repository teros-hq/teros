# Discord MCA

Full Discord integration for Teros agents: guilds, channels, messages, members, roles, webhooks, threads, reactions, and moderation.

## Authentication

The MCA supports two authentication methods:

1. **OAuth 2.0** — Users connect their Discord account via OAuth flow
2. **Bot Token** — A Discord bot token can be provided in user secrets for bot operations

### Required OAuth Scopes
- `identify` — Basic user info
- `guilds` — List guilds the user is in
- `guilds.members.read` — Read member info
- `bot` — Bot functionality
- `messages.read` — Read messages
- `applications.commands` — Slash commands

### System Secrets
- `CLIENT_ID` — Discord application client ID
- `CLIENT_SECRET` — Discord application client secret

### User Secrets
- `ACCESS_TOKEN` — OAuth access token (for user operations)
- `REFRESH_TOKEN` — OAuth refresh token
- `BOT_TOKEN` — Discord bot token (preferred for guild operations)
- `GUILD_ID` — Default guild ID for operations

## Tools

### Health Check
- `-health-check` — Verify credentials and API connectivity

### Guilds
- `list-guilds` — List servers the bot/user is a member of
- `get-guild` — Get detailed guild information

### Channels
- `list-channels` — List channels in a guild
- `get-channel` — Get channel details
- `create-channel` — Create a new channel (text, voice, category, announcement, forum, stage)
- `delete-channel` — Delete a channel

### Messages
- `send-message` — Send a message with text, embeds, mentions, and replies
- `list-messages` — List message history with pagination
- `delete-message` — Delete a specific message

### Reactions
- `add-reaction` — Add emoji reactions to messages

### Members
- `list-members` — List guild members with pagination
- `get-member` — Get specific member details

### Roles
- `list-roles` — List all guild roles
- `create-role` — Create a new role
- `assign-role` — Assign a role to a member
- `remove-role` — Remove a role from a member

### Webhooks
- `list-webhooks` — List webhooks in a guild or channel
- `create-webhook` — Create a new webhook
- `send-webhook-message` — Send messages via webhook

### Moderation
- `kick-member` — Kick a member from the guild
- `ban-member` — Ban a member with optional message deletion
- `timeout-member` — Timeout (mute) a member for a duration

## Rate Limiting

The MCA uses discord.js REST client which handles rate limiting automatically with exponential backoff and retry logic.

## Error Handling

All tools return human-readable error messages for common Discord API errors:
- Rate limits (429)
- Authentication failures (401)
- Permission denied (403)
- Resource not found (404)
- Missing access (50001)
- Missing permissions (50013)

## Usage Examples

### Send a message
```
discord_send_message channelId="123456789" content="Hello from Teros!"
```

### Create a channel
```
discord_create_channel guildId="123456789" name="announcements" type="text"
```

### Timeout a member
```
discord_timeout_member guildId="123456789" userId="987654321" durationMinutes=60 reason="Spam"
```
