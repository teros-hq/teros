# ElevenLabs MCA

Text-to-Speech integration for Teros using ElevenLabs AI voices.

## Features

- **Text-to-Speech**: Convert text to natural-sounding speech with multiple voices and models
- **Voice Management**: List and explore available voices (premade, cloned, generated)
- **Multi-Speaker Conversations**: Generate podcasts/dialogues from YAML scripts
- **Subscription Info**: Check character usage and limits

## Configuration

### System Secrets

The MCA requires an ElevenLabs API key configured as a system secret:

| Secret | Description |
|--------|-------------|
| `API_KEY` | Your ElevenLabs API key from https://elevenlabs.io |

### Getting an API Key

1. Create an account at https://elevenlabs.io
2. Go to Profile Settings → API Keys
3. Create a new API key
4. Add it to the system secrets as `API_KEY`

## Tools

### text_to_speech

Generate speech from text.

```json
{
  "text": "Hello, this is a test message.",
  "voiceId": "EXAVITQu4vr4xnSDxMaL",
  "modelId": "eleven_flash_v2_5",
  "stability": 0.5,
  "similarityBoost": 0.75,
  "outputFormat": "mp3_44100_128"
}
```

### list_voices

List available voices with optional filtering.

```json
{
  "search": "sarah",
  "category": "premade",
  "limit": 10
}
```

### get_voice

Get detailed information about a specific voice.

```json
{
  "voiceId": "EXAVITQu4vr4xnSDxMaL"
}
```

### generate_conversation

Generate a multi-speaker conversation from a YAML script.

```json
{
  "scriptPath": "/path/to/conversation.yaml"
}
```

### get_subscription

Check your ElevenLabs subscription status and character usage.

## Conversation Script Format

Create a YAML file with the following structure:

```yaml
voices:
  Alice: "EXAVITQu4vr4xnSDxMaL"  # Sarah
  Bob: "21m00Tcm4TlvDq8ikWAM"    # Rachel

config:
  pause_between_speakers: 0.8
  model_id: eleven_flash_v2_5
  output: /path/to/output.mp3

dialogue:
  - speaker: Alice
    text: "Hello Bob, how are you today?"
  - speaker: Bob
    text: "I'm doing great, thanks for asking!"
  - speaker: Alice
    text: "That's wonderful to hear."
```

## Models

| Model | Description |
|-------|-------------|
| `eleven_flash_v2_5` | Fastest, lowest latency (default) |
| `eleven_turbo_v2_5` | Fast with good quality |
| `eleven_turbo_v2` | Fast turbo model |
| `eleven_multilingual_v2` | Best quality for multiple languages |
| `eleven_multilingual_v1` | Original multilingual model |
| `eleven_monolingual_v1` | English only, original model |

## Output Formats

| Format | Description |
|--------|-------------|
| `mp3_44100_128` | MP3, 44.1kHz, 128kbps (default) |
| `mp3_44100_192` | MP3, 44.1kHz, 192kbps |
| `pcm_16000` | PCM, 16kHz |
| `pcm_22050` | PCM, 22.05kHz |
| `pcm_24000` | PCM, 24kHz |
| `pcm_44100` | PCM, 44.1kHz |

## Requirements

- **ffmpeg**: Required for `generate_conversation` tool to combine audio segments

## Development

```bash
cd mcp
bun install
bun run index.ts
```
