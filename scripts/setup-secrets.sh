#!/bin/bash

# =============================================================================
# Teros - Setup Secrets
#
# Generates the minimum required secrets for the backend to start.
# Run this once after cloning the repo, before docker compose up.
#
# Usage:
#   bash scripts/setup-secrets.sh
# =============================================================================

set -e

SECRETS_DIR=".secrets/system"

echo ""
echo "🔐 Teros - Setup Secrets"
echo "========================"
echo ""

# Check if node is available
if ! command -v node &> /dev/null; then
  echo "❌ Error: node is required to generate secrets."
  echo "   Install Node.js and try again."
  exit 1
fi

mkdir -p "$SECRETS_DIR"

# -----------------------------------------------------------------------------
# encryption.json — REQUIRED
# Used to encrypt/decrypt all user credentials stored in the database.
# If you lose this key, all stored credentials become unrecoverable.
# -----------------------------------------------------------------------------
ENCRYPTION_FILE="$SECRETS_DIR/encryption.json"

if [ -f "$ENCRYPTION_FILE" ]; then
  echo "⚠️  $ENCRYPTION_FILE already exists — skipping (delete it manually to regenerate)"
else
  MASTER_KEY=$(node -e "const {randomBytes}=require('crypto'); process.stdout.write(randomBytes(32).toString('hex'))")
  echo "{ \"masterKey\": \"$MASTER_KEY\" }" > "$ENCRYPTION_FILE"
  echo "✅ Generated $ENCRYPTION_FILE"
  echo "   ⚠️  IMPORTANT: Back this up! Losing it means losing all stored credentials."
fi

echo ""

# -----------------------------------------------------------------------------
# auth.json — REQUIRED
# Used to sign session tokens.
# -----------------------------------------------------------------------------
AUTH_FILE="$SECRETS_DIR/auth.json"

if [ -f "$AUTH_FILE" ]; then
  echo "⚠️  $AUTH_FILE already exists — skipping (delete it manually to regenerate)"
else
  SESSION_SECRET=$(node -e "const {randomBytes}=require('crypto'); process.stdout.write(randomBytes(32).toString('hex'))")
  echo "{ \"sessionTokenSecret\": \"$SESSION_SECRET\" }" > "$AUTH_FILE"
  echo "✅ Generated $AUTH_FILE"
fi

echo ""
echo "✅ Done! You can now run: docker compose up"
echo ""
