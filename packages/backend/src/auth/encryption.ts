/**
 * Encryption utilities for user credentials
 *
 * Uses AES-256-GCM for authenticated encryption
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import type { EncryptedData } from './types';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits
const TAG_LENGTH = 16; // 128 bits

/**
 * Encrypt data with AES-256-GCM
 */
export function encrypt(data: any, key: Buffer): EncryptedData {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Encryption key must be ${KEY_LENGTH} bytes`);
  }

  // Generate random IV
  const iv = randomBytes(IV_LENGTH);

  // Create cipher
  const cipher = createCipheriv(ALGORITHM, key, iv);

  // Encrypt data
  const dataString = JSON.stringify(data);
  let encrypted = cipher.update(dataString, 'utf8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);

  // Get authentication tag
  const tag = cipher.getAuthTag();

  return {
    data: encrypted.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
  };
}

/**
 * Decrypt data with AES-256-GCM
 */
export function decrypt(encrypted: EncryptedData, key: Buffer): any {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`Decryption key must be ${KEY_LENGTH} bytes`);
  }

  // Convert hex strings to buffers
  const encryptedBuffer = Buffer.from(encrypted.data, 'hex');
  const iv = Buffer.from(encrypted.iv, 'hex');
  const tag = Buffer.from(encrypted.tag, 'hex');

  // Create decipher
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  // Decrypt data
  let decrypted = decipher.update(encryptedBuffer);
  decrypted = Buffer.concat([decrypted, decipher.final()]);

  // Parse JSON
  const dataString = decrypted.toString('utf8');
  return JSON.parse(dataString);
}

/**
 * Generate a random encryption key
 */
export function generateKey(): Buffer {
  return randomBytes(KEY_LENGTH);
}

/**
 * Generate a random salt
 */
export function generateSalt(): Buffer {
  return randomBytes(32); // 256 bits
}
