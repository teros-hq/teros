# @teros/shared

Shared types and protocols for Teros.

## Overview

This package contains:
- **WebSocket Protocol** - Strictly typed client-server communication
- **Zod Schemas** - Runtime validation for all messages
- **Type-safe Interfaces** - Shared types between frontend and backend

## Usage

```typescript
import {
  ClientMessage,
  ServerMessage,
  parseClientMessage,
  parseServerMessage,
  Channel,
  Message,
  AgentConfig,
} from '@teros/shared';

// Parse and validate incoming message
const message = parseClientMessage(data);

// Type-safe access
if (message.type === 'send_message') {
  console.log(message.channelId);
  console.log(message.content);
}
```

## Protocol

See `src/protocol.ts` for complete protocol specification.

### Client -> Server Messages

- `auth` - Authenticate (credentials or token)
- `list_channels` - List user's channels
- `create_channel` - Create new channel with agent
- `get_channel` - Get channel details
- `close_channel` - Close a channel
- `send_message` - Send message to channel
- `get_messages` - Get message history
- `subscribe_channel` - Subscribe to channel events
- `unsubscribe_channel` - Unsubscribe from channel
- `typing_start` / `typing_stop` - Typing indicators

### Server -> Client Messages

- `auth_success` / `auth_error` - Authentication result
- `channels_list` - List of channels
- `channel_created` - Channel created confirmation
- `channel_details` - Full channel details
- `channel_closed` - Channel closed notification
- `message_sent` - Message sent confirmation
- `message` - New message received
- `messages_history` - Message history response
- `typing` - Typing indicator from agent
- `error` - Error message

## Building

```bash
bun run build
```

## License

MIT
