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

# Copy system secrets
echo "📁 System secrets:"
for file in $SECRETS_DIR/system/*.example.json; do
  if [ -f "$file" ]; then
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
Echo "   chmod 600 $SECRETS_DIR/**/*.json"

