#!/usr/bin/env bun

/**
 * Generate a random MCA internal token for service-to-service authentication
 *
 * This token is used to secure internal endpoints like /api/event and /api/mca-event
 * from unauthorized external access.
 *
 * Usage:
 *   bun run scripts/generate-mca-internal-token.ts
 *
 * The full token is written to a file (mca.token.json) so it is not
 * echoed in terminal scrollback or CI logs. Only a masked prefix is shown.
 */

import { randomBytes } from 'crypto';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🔐 Generating MCA internal token...\n');

const token = randomBytes(32); // 256 bits = 64 hex chars
const hexToken = token.toString('hex');

// Mask: show only first 8 chars so the user can verify they have the right token
const masked = hexToken.substring(0, 8) + '…(masked)';

const outputPath = join(__dirname, 'mca.token.json');
const payload = { internalToken: hexToken };

writeFileSync(outputPath, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });

console.log(`Generated MCA internal token (masked): ${masked}`);
console.log(`Full token written to: ${outputPath}`);
console.log('');
console.log('⚠️  IMPORTANT: This token is used for internal service authentication.');
console.log('   It must be added to the backend secrets and configured in any');
console.log('   external services that need to call /api/event or /api/mca-event.');
console.log('   Move the generated file to .secrets/system/mca.json and delete the temp file.');
