# Perplexity AI MCA

AI-powered web search with real-time information using Perplexity API.

## Features

- **Real-time web search**: Get up-to-date information from the web
- **Multiple models**: Choose from sonar, sonar-pro, or sonar-reasoning
- **Source citations**: Automatic citation of sources used in answers
- **Multi-turn conversations**: Maintain context across multiple messages

## Configuration

### Secrets File

Credentials are automatically loaded by the backend's **SecretsManager** and injected as environment variables.

**Location:** `.secrets/mcas/mca.teros.perplexity/credentials.json`

```json
{
  "apiKey": "pplx-your-api-key-here"
}
```

Get your API key from: https://www.perplexity.ai/settings/api

**Setup:**
```bash
# Create secrets directory
mkdir -p .secrets/mcas/mca.teros.perplexity

# Create credentials file
cat > .secrets/mcas/mca.teros.perplexity/credentials.json << EOF
{
  "apiKey": "pplx-your-actual-api-key-here"
}
EOF

# Set proper permissions
chmod 600 .secrets/mcas/mca.teros.perplexity/credentials.json
```

**How it works:**
1. Backend loads secrets on startup using `SecretsManager`
2. Secrets are stored in `app.secrets` when the app is created
3. When spawning the MCA process, secrets are injected as `MCA_SECRET_APIKEY`
4. The MCA reads from `process.env.MCA_SECRET_APIKEY`

No manual environment variable configuration needed!

## Tools

### perplexity_search

Search the web using Perplexity AI with real-time information.

**Parameters:**
- `query` (string, required): The search query or question
- `model` (string, optional): Model to use (default: "sonar")
  - `sonar`: Fast and efficient
  - `sonar-pro`: More comprehensive answers
  - `sonar-reasoning`: Advanced reasoning capabilities

**Example:**
```typescript
{
  "query": "What are the latest developments in quantum computing?",
  "model": "sonar-pro"
}
```

### perplexity_chat

Have a multi-turn conversation with Perplexity AI.

**Parameters:**
- `messages` (array, required): Array of message objects
  - `role`: "system", "user", or "assistant"
  - `content`: Message content
- `model` (string, optional): Model to use (default: "sonar")

**Example:**
```typescript
{
  "messages": [
    {
      "role": "system",
      "content": "You are a helpful research assistant."
    },
    {
      "role": "user",
      "content": "What is the capital of France?"
    },
    {
      "role": "assistant",
      "content": "The capital of France is Paris."
    },
    {
      "role": "user",
      "content": "What is its population?"
    }
  ],
  "model": "sonar"
}
```

## Usage Tips

- Use `sonar` for quick searches and general questions
- Use `sonar-pro` for more detailed research and comprehensive answers
- Use `sonar-reasoning` for complex analysis and reasoning tasks
- Citations are automatically included when available

## Limitations

- Requires valid Perplexity API key
- Subject to Perplexity API rate limits
- Response quality depends on the selected model
