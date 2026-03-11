#!/bin/bash
set -e

PROFILE="${1:-preview}"

echo "🔍 Running expo-doctor to check for issues..."
echo ""

# Run expo-doctor and capture output
DOCTOR_OUTPUT=$(bunx expo-doctor 2>&1)
DOCTOR_EXIT=$?

echo "$DOCTOR_OUTPUT"
echo ""

# Check if all checks passed
if echo "$DOCTOR_OUTPUT" | grep -q "checks passed. 0 checks failed"; then
    echo "✅ All expo-doctor checks passed!"
    echo ""
    echo "🚀 Starting iOS build with profile: $PROFILE"
    echo ""
    bunx eas-cli build --platform ios --profile "$PROFILE" --non-interactive --no-wait
else
    echo ""
    echo "❌ expo-doctor found issues. Please fix them before building."
    echo ""
    echo "Common fixes:"
    echo "  1. Delete node_modules and yarn.lock, then run 'yarn install'"
    echo "  2. Check package.json for version mismatches"
    echo "  3. Run 'bunx expo install --fix' to fix dependency versions"
    echo ""
    exit 1
fi
