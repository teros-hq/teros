# @teros/backend

Teros WebSocket Backend Server

## Overview

WebSocket server that handles real-time communication between clients and AI agents. Replaces NATS-based architecture with direct WebSocket connections.

## Features

- **Authentication**: Email/password + token-based sessions
- **Channel Management**: Create, list, get details, close channels
- **Real-time Messaging**: Send/receive messages with persistence
- **Typing Indicators**: Real-time typing status
- **Agent Communication**: Mock agent responses (to be replaced with real agent processing)

## Architecture

```
WebSocket Server (ws)
├── WebSocketHandler     - Main connection handler
├── AuthHandler          - Authentication logic
├── ChannelHandler       - Channel CRUD operations
├── MessageHandler       - Message send/receive
├── SessionManager       - Active sessions (in-memory)
└── ChannelManager       - MongoDB channel operations
```

## Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
# Server
PORT=3001

# MongoDB
MONGODB_URI=mongodb://localhost:27017
MONGODB_DATABASE=teros

# Auth
SESSION_TOKEN_SECRET=your-secret-here
```

## Development

```bash
# Install dependencies (from root)
bun install

# Build
bun run build

# Run in development mode (with hot reload)
bun run dev

# Run in production mode
bun run start
```

## Protocol

Uses `@teros/shared` protocol definitions. All messages are JSON with Zod validation.

### Client Messages
- `auth_credentials` - Authenticate with email/password
- `auth_token` - Authenticate with session token
- `list_channels` - Get user's channels
- `create_channel` - Create new channel
- `get_channel` - Get channel details
- `close_channel` - Close a channel
- `subscribe_channel` - Subscribe to channel updates
- `unsubscribe_channel` - Unsubscribe from channel
- `send_message` - Send message to channel
- `get_messages` - Get channel message history
- `typing_start` / `typing_stop` - Typing indicators

### Server Messages
- `auth_success` - Authentication successful + token
- `auth_error` - Authentication failed
- `channels_list` - List of channels
- `channel_created` - New channel created
- `channel_details` - Channel details
- `channel_closed` - Channel closed
- `new_message` - New message received
- `messages_history` - Message history
- `user_typing` - User typing indicator
- `error` - General error

## Database Schema

See `docs/DATABASE.md` for MongoDB schema.

Collections used:
- `users` - User accounts
- `channels` - Communication channels
- `messages` - Chat messages
- `agent_configs` - Agent configurations
- `user_apps` - User app instances

## Next Steps

1. **Replace mock agent**: Integrate real agent processing
2. **Add Redis**: For distributed session management
3. **Add rate limiting**: Prevent abuse
4. **Add metrics**: Monitor performance
5. **Add logging**: Structured logging
