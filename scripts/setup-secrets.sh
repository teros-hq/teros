#!/bin/bash

# Setup Secrets Script
# Copies example secret files to actual secret files

set -e

SECRETS_DIR=".secrets"

echo "🔐 Setting up secrets..."
echo ""

# Check if .secrets directory exists
if [ ! -d "$SECRETS_DIR" ]; then
  echo "❌ Error: $SECRETS_DIR directory not found"
  exit 1
fi

# Function to copy example file if target doesn't exist
copy_if_not_exists() {
  local example_file=$1
  local target_file=${example_file%.example.json}.json

  if [ -f "$target_file" ]; then
    echo "⏭️  Skipping $target_file (already exists)"
  else
    cp "$example_file" "$target_file"
    echo "✅ Created $target_file"
  fi
}

# Special: generate real encryption key instead of copying the invalid placeholder
# from encryption.example.json (the example contains a literal string that is NOT
# valid hex, which would make AES-GCM fail at runtime). If encryption.json already
# exists we leave it alone.
generate_encryption_key() {
  local target_file="$SECRETS_DIR/system/encryption.json"
  if [ -f "$target_file" ]; then
    echo "⏭️  Skipping $target_file (already exists)"
    return
  fi
  local key
  key=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
  node -e "require('fs').writeFileSync('$target_file', JSON.stringify({masterKey:'$key'},null,2)+'\n')"
  echo "🔑 Generated $target_file with a fresh 32-byte key"
}

# Copy system secrets
echo "📁 System secrets:"
# Generate encryption key first (not copied from .example, see note above)
generate_encryption_key
for file in $SECRETS_DIR/system/*.example.json; do
  if [ -f "$file" ]; then
    # Skip encryption.example.json — handled by generate_encryption_key above
    if [[ "$file" == *"encryption.example.json" ]]; then
      continue
    fi
    copy_if_not_exists "$file"
  fi
done

echo ""
echo "📁 MCA secrets:"
# Copy MCA secrets
for file in $SECRETS_DIR/mcas/**/credentials.example.json; do
  if [ -f "$file" ]; then
    copy_if_not_exists "$file"
  fi
done

echo ""
echo "✨ Done!"
echo ""
echo "⚠️  IMPORTANT: Edit the secret files and add your actual credentials:"
echo "   - $SECRETS_DIR/system/anthropic.json"
echo "   - $SECRETS_DIR/system/openai.json"
echo "   - $SECRETS_DIR/system/database.json"
echo "   - $SECRETS_DIR/system/auth.json"
echo ""
echo "🔒 Set proper permissions:"
echo "   chmod 600 $SECRETS_DIR/**/*.json"

