# mca.teros.memory

System-level MCA that unifies memory and vector database operations.

## Description

This MCA provides both conversation memory management and Qdrant vector database operations in a single interface. It's a system-level MCA (not user-specific) that handles:

- Conversation history storage and retrieval
- Knowledge base management
- Importance scoring for conversations
- Vector search and collection management via Qdrant

## Tools (15 total)

### Memory Tools (7)
- `memory_search_conversations` - Search conversation history
- `memory_save_conversation` - Save conversations with importance scoring
- `memory_save_knowledge` - Add knowledge to the knowledge base
- `memory_search_knowledge` - Search the knowledge base
- `memory_get_knowledge_by_category` - Get knowledge by category
- `memory_calculate_importance` - Calculate conversation importance
- `memory_get_context_for_query` - Get relevant context for prompts

### Qdrant Tools (8)
- `qdrant_list_collections` - List all collections
- `qdrant_create_collection` - Create a new collection
- `qdrant_delete_collection` - Delete a collection
- `qdrant_get_collection_info` - Get collection details
- `qdrant_upsert_points` - Insert/update vectors
- `qdrant_search` - Search for similar vectors
- `qdrant_scroll_points` - Retrieve points with pagination
- `qdrant_delete_points` - Delete points by ID or filter

## Configuration

### Required Environment Variables
- `QDRANT_URL` - Qdrant server URL (default: http://localhost:6333)
- `QDRANT_API_KEY` - Qdrant API key

## Type

System MCA - shared infrastructure, not user-specific.

## Dependencies

- Core memory system (`memory/` directory)
- Qdrant vector database
- OpenAI embeddings (via memory system)
