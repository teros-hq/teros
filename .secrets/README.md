# Secrets Directory

This directory contains all system secrets and MCA credentials.

⚠️ **IMPORTANT:** Never commit actual secret files to git!

## Setup

1. Copy example files and remove `.example` from filename:
```bash
cp system/anthropic.example.json system/anthropic.json
cp system/openai.example.json system/openai.json
cp system/database.example.json system/database.json
cp system/auth.example.json system/auth.json
```

2. Edit the files and add your actual credentials

3. For MCAs:
```bash
cp mcas/mca.teros.perplexity/credentials.example.json mcas/mca.teros.perplexity/credentials.json
```

## Structure

```
.secrets/
├── system/                      # System-wide secrets
│   ├── anthropic.json          # Anthropic API key
│   ├── openai.json             # OpenAI API key
│   ├── database.json           # MongoDB connection
│   └── auth.json               # Session secrets
│
└── mcas/                        # MCA-specific secrets
    ├── mca.teros.perplexity/
    │   └── credentials.json
    └── mca.teros.gmail/
        └── credentials.json
```

## Security

- File permissions: `chmod 600 .secrets/**/*.json`
- Never commit to git (included in .gitignore)
- Keep backups in a secure location
- Rotate secrets regularly
