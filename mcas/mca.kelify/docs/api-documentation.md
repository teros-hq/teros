# Kelify AI Search API Documentation

## Overview
The Kelify AI Search API provides conversational property search functionality. Partners can create conversations and send messages to receive AI-powered property recommendations via Server-Sent Events (SSE) streaming.

## Base URL
```
https://api.kelify.com
```

## Authentication
Uses Bearer token authentication. Partner API key format: `kfy_<random_string>`

Example: `Authorization: Bearer kfy_mHoziCvCeZFKDKGowKPtz2rVnkuD4TDI`

## Endpoints

### 1. Create a new conversation
**POST** `/v1/conversations`

Creates a new conversation session. Each conversation maintains context across multiple messages, allowing for natural follow-up questions.

**Responses:**
- `201` - Conversation created
- `401` - Invalid API key  
- `500` - Server error

**Response Body (201):**
```json
{
  "conversation_id": "550e8400-e29b-41d4-a716-446655440000",
  "created_at": "2026-01-08T10:30:00Z"
}
```

### 2. Get conversation details
**GET** `/v1/conversations/{conversation_id}`

Retrieves full conversation history including all messages and usage statistics.

**Parameters:**
- `conversation_id` (path, required) - Conversation UUID

**Responses:**
- `200` - Conversation details
- `401` - Invalid API key
- `404` - Conversation not found

**Response Body (200):**
```json
{
  "conversation_id": "550e8400-e29b-41d4-a716-446655440000",
  "created_at": "2026-01-08T10:30:00Z",
  "updated_at": "2026-01-08T11:15:00Z",
  "title": "Apartments in Madrid",
  "messages": [
    {
      "role": "user",
      "content": "Busco un piso de 2 habitaciones Madrid por menos de 3000 euros",
      "timestamp": "2026-01-08T10:31:00Z"
    },
    {
      "role": "assistant", 
      "content": "He encontrado varios pisos de 2 habitaciones en Madrid...",
      "timestamp": "2026-01-08T10:31:30Z"
    }
  ],
  "usage": {
    "input_tokens": 150,
    "output_tokens": 320,
    "total_tokens": 470
  }
}
```

### 3. Send a message and receive AI response
**POST** `/v1/conversations/{conversation_id}/messages`

Sends a user message to conversation and receives an AI response.

**Parameters:**
- `conversation_id` (path, required) - Conversation UUID

**Request Body:**
```json
{
  "message": "Busco un piso de 2 habitaciones Madrid por menos de 3000 euros",
  "stream": true
}
```

**Fields:**
- `message` (required, string, 1-2000 chars) - The user's message to the AI assistant
- `stream` (optional, boolean, default: true) - Whether to stream response via SSE

**Responses:**
- `200` - Response (SSE stream when stream=true, JSON when stream=false)
- `201` - Complete response when stream=false
- `400` - Invalid request
- `401` - Invalid API key
- `403` - Conversation closed
- `404` - Conversation not found

## Streaming Mode (default)

By default (`stream: true`), response is delivered via Server-Sent Events (SSE).

### SSE Event Types
- `status` - Processing status update
- `delta` - Incremental text chunk of AI response
- `search_results` - Properties matching search criteria
- `done` - Conversation complete with usage stats
- `error` - Error occurred during processing

### Example SSE Stream
```
event: status
data: {"status": "processing"}

event: delta
data: {"content": "I found "}

event: delta
data: {"content": "several apartments"}

event: search_results
data: {"count": 5, "properties": [...], "search_params": {...}}

event: done
data: {"conversation_id": "...", "title": "Apartments in Madrid", "usage": {...}}
```

## Non-Streaming Mode

Set `stream: false` to receive a complete JSON response. This is useful for:
- Serverless/Lambda environments with connection timeouts
- Simple integrations that don't need real-time updates
- Environments where SSE is difficult to handle

**Note**: Non-streaming requests may take 10-30+ seconds to complete. Ensure your HTTP client is configured with an appropriate timeout.

**Response Body (201):**
```json
{
  "conversation_id": "550e8400-e29b-41d4-a716-446655440000",
  "title": "Pisos en Madrid",
  "message": {
    "role": "assistant",
    "content": "He encontrado varios pisos de 2 habitaciones en Madrid..."
  },
  "search_results": {
    "count": 5,
    "properties": [...],
    "search_params": {
      "max_price": 3000,
      "operation": "rent",
      "rooms": [2]
    }
  },
  "usage": {
    "input_tokens": 150,
    "output_tokens": 320,
    "total_tokens": 470
  }
}
```

## Data Models

### Property
A real estate property listing
```json
{
  "id": "abc123",
  "title": "Bright apartment in Salamanca",
  "address": "Calle Serrano 50, Madrid",
  "price": 1200,
  "operation": "rent",
  "home_type": "flat",
  "rooms": 2,
  "bathrooms": 1,
  "size": 85,
  "latitude": 40.4255,
  "longitude": -3.6832,
  "photos": ["https://example.com/photo1.jpg"],
  "url": "https://kelify.com/properties/abc123"
}
```

### SearchParams
Search criteria applied by the AI
```json
{
  "operation": "rent",
  "rooms": [2, 3],
  "max_price": 1500,
  "home_types": ["flat"],
  "sort_by": "price",
  "sort_direction": "asc",
  "area": {...},
  "agency_name": "...",
  "bathrooms": [...],
  "condition": [...],
  "days_ago": 30,
  "features": [...],
  "furnishing": "furnished",
  "hide_bare_property": false,
  "hide_professionals": false,
  "hide_seasonal_rentals": false,
  "is_exterior": true,
  "max_floor": 5,
  "max_size": 120,
  "min_floor": 1,
  "min_price": 800,
  "min_size": 60,
  "no_agency_commission": true
}
```

### Usage
Token usage statistics for the conversation
```json
{
  "input_tokens": 450,
  "output_tokens": 800,
  "total_tokens": 1250
}
```

## Contact and Support
For API support and documentation updates, contact Kelify partners team.