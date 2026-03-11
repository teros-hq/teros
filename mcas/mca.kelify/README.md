# mca.kelify - Kelify AI Property Search MCA

An MCA (Model Context App) that provides access to the Kelify AI-powered conversational property search API. This allows AI agents to search for real estate properties using natural language conversations.

## Features

- **Conversational Search**: Natural language property search with context maintained across multiple messages
- **Real-time Streaming**: Server-Sent Events (SSE) support for real-time responses
- **Comprehensive Property Data**: Detailed property information including photos, location, and pricing
- **Advanced Search Filters**: Support for complex search criteria (price, rooms, location, features, etc.)
- **Usage Tracking**: Token usage statistics for monitoring and billing

## Available Tools

### 1. `kelify_create_conversation`
Creates a new conversation session for property search. Each conversation maintains context across multiple messages.

**Usage:**
```typescript
const result = await kelify_create_conversation();
console.log(result.conversation_id); // "550e8400-e29b-41d4-a716-446655440000"
```

### 2. `kelify_send_message`
Send a user message to a conversation and receive an AI response with property search results.

**Parameters:**
- `conversation_id` (required): The conversation UUID
- `message` (required): The search query (1-2000 characters)
- `stream` (optional): Whether to use streaming (default: true)

**Usage:**
```typescript
const result = await kelify_send_message({
  conversation_id: "550e8400-e29b-41d4-a716-446655440000",
  message: "Busco un piso de 2 habitaciones en Madrid por menos de 3000 euros"
});
```

### 3. `kelify_get_conversation`
Retrieve full conversation history including all messages and usage statistics.

**Parameters:**
- `conversation_id` (required): The conversation UUID

**Usage:**
```typescript
const conversation = await kelify_get_conversation({
  conversation_id: "550e8400-e29b-41d4-a716-446655440000"
});
```

## Installation

1. Install dependencies:
```bash
npm install
```

2. Build the project:
```bash
npm run build
```

3. Set environment variables:
```bash
export KELIFY_API_KEY="your_api_key_here"
export KELIFY_API_BASE_URL="https://api.kelify.com"  # optional
```

## Configuration

The MCA requires the following configuration:

### Environment Variables
- `KELIFY_API_KEY` (required): Your Kelify API key
- `KELIFY_API_BASE_URL` (optional): Base URL for the API (defaults to https://api.kelify.com)

### Required Secrets
- `api_key`: Kelify API key for authentication

## Usage Examples

### Basic Property Search
```typescript
// Create a new conversation
const conversation = await kelify_create_conversation();

// Search for properties
const results = await kelify_send_message({
  conversation_id: conversation.conversation_id,
  message: "Busco un piso de 2 habitaciones en Madrid centro con parking"
});

console.log(`Found ${results.search_results.count} properties`);
```

### Advanced Search with Filters
```typescript
const results = await kelify_send_message({
  conversation_id: conversation.conversation_id,
  message: "Looking for apartments in Barcelona, max 2500€, 3 bedrooms, exterior, with terrace"
});
```

### Multi-turn Conversation
```typescript
// First search
let results = await kelify_send_message({
  conversation_id: conversation.conversation_id,
  message: "Apartments in Valencia"
});

// Follow-up question
results = await kelify_send_message({
  conversation_id: conversation.conversation_id,
  message: "Show me only the ones with a swimming pool"
});
```

## Response Format

### Property Object
```typescript
{
  id: "abc123",
  title: "Bright apartment in Salamanca",
  address: "Calle Serrano 50, Madrid",
  price: 1200,
  operation: "rent",
  home_type: "flat",
  rooms: 2,
  bathrooms: 1,
  size: 85,
  latitude: 40.4255,
  longitude: -3.6832,
  photos: ["https://example.com/photo1.jpg"],
  url: "https://kelify.com/properties/abc123"
}
```

### Search Results
```typescript
{
  count: 5,
  properties: [Property[], ...],
  search_params: {
    operation: "rent",
    rooms: [2],
    max_price: 3000,
    sort_by: "price",
    sort_direction: "asc"
  }
}
```

## Error Handling

All functions return a standardized response format:

```typescript
{
  success: boolean,
  data?: any,           // Present when success: true
  error?: string         // Present when success: false
}
```

Common errors:
- `Invalid API key` - Authentication failed
- `Conversation not found` - Invalid conversation ID
- `Conversation is closed` - Conversation can no longer accept messages
- `Request timeout` - API request took too long

## Streaming Support

When `stream: true`, the response is delivered via Server-Sent Events:

- `status` - Processing status updates
- `delta` - Incremental text chunks of the AI response
- `search_results` - Property search results
- `done` - Conversation completion with usage stats
- `error` - Error events

## Rate Limits

Please refer to the Kelify API documentation for current rate limits and usage policies.

## Development

### Build
```bash
npm run build
```

### Development Mode
```bash
npm run dev
```

### Clean Build
```bash
npm run clean
```

## License

MIT License - see LICENSE file for details.

## Support

For API support and documentation:
- API Documentation: `docs/api-documentation.md`
- Kelify Website: https://kelify.com
- Contact: partners@kelify.com

## Changelog

### v1.0.0
- Initial release with full Kelify API integration
- Support for conversation creation and management
- Property search with natural language
- Streaming responses via SSE
- Complete property data models