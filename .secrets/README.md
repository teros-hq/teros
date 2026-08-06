# Secrets Directory

This directory contains all system secrets and MCA credentials.

⚠️ **IMPORTANT:** Never commit actual secret files to git!

## Setup

1. Copy example files and remove `.example` from filename:
```bash
cp system/encryption.example.json system/encryption.json   # REQUIRED — the backend refuses to boot without it
cp system/anthropic.example.json system/anthropic.json
cp system/openai.example.json system/openai.json
cp system/database.example.json system/database.json
cp system/auth.example.json system/auth.json
cp system/mca.example.json system/mca.json
```

2. Generate the encryption master key (REQUIRED — encrypts all user credentials; boot fails without it):
```bash
bun run scripts/generate-encryption-key.ts
# Or with Node:
node -e "const crypto = require('crypto'); console.log(JSON.stringify({masterKey: crypto.randomBytes(32).toString('hex')}, null, 2));"
```
Write the output into `.secrets/system/encryption.json` (replace the `GENERATE_…` placeholder).

3. Generate the MCA internal token (required for service-to-service authentication):
```bash
bun run scripts/generate-mca-internal-token.ts
# Or with Node:
node -e "const crypto = require('crypto'); console.log(JSON.stringify({internalToken: crypto.randomBytes(32).toString('hex')}));"
```
Then add the output to `.secrets/system/mca.json`

4. Edit the remaining files and add your actual credentials

5. For MCAs:
```bash
cp mcas/mca.teros.perplexity/credentials.example.json mcas/mca.teros.perplexity/credentials.json
```

## Structure

```
.secrets/
├── system/                      # System-wide secrets
│   ├── encryption.json         # Master key for user-credential encryption (REQUIRED to boot)
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
