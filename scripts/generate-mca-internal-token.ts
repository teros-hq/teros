#!/usr/bin/env bun

/**
 * Generate a random MCA internal token for service-to-service authentication
 *
 * This token is used to secure internal endpoints like /api/event and /api/mca-event
 * from unauthorized external access.
 *
 * Usage:
 *   bun run scripts/generate-mca-internal-token.ts
 */

import { randomBytes } from 'crypto';

console.log('🔐 Generating MCA internal token...\n');

const token = randomBytes(32); // 256 bits = 64 hex chars
const hexToken = token.toString('hex');

console.log('Generated MCA internal token:');
console.log(hexToken);
console.log('');
console.log('Add this to .secrets/system/mca.json:');
console.log(JSON.stringify({ internalToken: hexToken }, null, 2));
console.log('');
console.log('⚠️  IMPORTANT: This token is used for internal service authentication.');
console.log('   It must be added to the backend secrets and configured in any');
console.log('   external services that need to call /api/event or /api/mca-event.');
