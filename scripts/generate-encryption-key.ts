#!/usr/bin/env bun

/**
 * Generate a random encryption key for system
 *
 * Usage:
 *   bun run scripts/generate-encryption-key.ts
 *
 * The full key is written to a file (encryption.key.json) so it is not
 * echoed in terminal scrollback or CI logs. Only a masked prefix is shown.
 */

import { randomBytes } from 'crypto';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🔐 Generating system encryption key...\n');

const key = randomBytes(32); // 256 bits
const hexKey = key.toString('hex');

// Mask: show only first 8 chars so the user can verify they have the right key
const masked = hexKey.substring(0, 8) + '…(masked)';

const outputPath = join(__dirname, 'encryption.key.json');
const payload = { masterKey: hexKey };

writeFileSync(outputPath, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });

console.log(`Generated encryption key (masked): ${masked}`);
console.log(`Full key written to: ${outputPath}`);
console.log('');
console.log('⚠️  IMPORTANT: Keep this key secret and backed up!');
console.log('   If you lose this key, all user credentials will be unrecoverable.');
console.log('   Move the generated file to .secrets/system/encryption.json and delete the temp file.');
