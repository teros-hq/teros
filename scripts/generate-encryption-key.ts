#!/usr/bin/env bun

/**
 * Generate a random encryption key for system
 *
 * Usage:
 *   bun run scripts/generate-encryption-key.ts
 */

import { randomBytes } from 'crypto';

console.log('🔐 Generating system encryption key...\n');

const key = randomBytes(32); // 256 bits
const hexKey = key.toString('hex');

console.log('Generated encryption key:');
console.log(hexKey);
console.log('');
console.log('Add this to .secrets/system/encryption.json:');
console.log(JSON.stringify({ masterKey: hexKey }, null, 2));
console.log('');
console.log('⚠️  IMPORTANT: Keep this key secret and backed up!');
console.log('   If you lose this key, all user credentials will be unrecoverable.');
