# mca.teros.conversations

Access and search past conversations and messages from the Teros database.

## Overview

This MCA provides agents with the ability to access conversation history, enabling them to:
- Search for information mentioned in past conversations
- Remember context from previous discussions
- Find decisions or agreements made earlier

## Tools

### search-messages

Search for text across all past conversations.

```json
{
  "query": "project deadline",
  "limit": 50
}
```

Returns matches grouped by channel with context snippets.

### list-channels

List past conversations with metadata.

```json
{
  "status": "active",
  "limit": 20
}
```

### get-channel-messages

Get messages from a specific conversation.

```json
{
  "channelId": "ch_abc123",
  "limit": 50,
  "textOnly": true
}
```

### get-channel-summary

Get a quick summary of a conversation without all messages.

```json
{
  "channelId": "ch_abc123"
}
```

## Security

- Only accesses conversations owned by the authenticated user
- Current channel is automatically excluded to prevent recursion
- Uses WebSocket communication with backend (no direct DB access)

## Architecture

```
Agent → MCA (MCP/stdio) → Backend (WebSocket) → MongoDB
```

The MCA communicates with the backend via WebSocket using the `query_conversations` message type. The backend validates ownership and performs the actual database queries.

## Configuration

This is a system MCA that requires no user configuration. It uses the WebSocket connection established by the MCA runtime.

Environment variables (set by runtime):
- `MCA_APP_ID` - The app instance ID
- `MCA_CHANNEL_ID` - Current channel (excluded from results)
- `MCA_WS_ENABLED` - Enable WebSocket communication
- `MCA_WS_URL` - WebSocket URL for backend connection
