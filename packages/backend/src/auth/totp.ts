/**
 * TOTP (Time-based One-Time Password) implementation
 *
 * Implements RFC 6238 TOTP using Node.js built-in crypto.
 * No external dependencies — uses HMAC-SHA1 (standard for TOTP).
 *
 * Compatible with Google Authenticator, Authy, 1Password, etc.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

// TOTP parameters per RFC 6238
const STEP_SECONDS = 30; // Time step (30 seconds is standard)
const DIGITS = 6; // 6-digit code (standard)
const ALGORITHM = 'sha1'; // HMAC-SHA1 (standard, compatible with all authenticator apps)
const SECRET_LENGTH_BYTES = 20; // 160 bits (recommended by RFC 4226)

/**
 * Generate a random TOTP secret (base32-encoded).
 * Returns a base32 string suitable for storing and generating QR codes.
 */
export function generateTOTPSecret(): string {
  const secretBytes = randomBytes(SECRET_LENGTH_BYTES);
  return base32Encode(secretBytes);
}

/**
 * Generate a TOTP code for the given secret at the given time.
 *
 * @param secretBase32 - Base32-encoded secret
 * @param timestamp - Unix timestamp in seconds (default: now)
 * @returns 6-digit TOTP code as a string
 */
export function generateTOTP(secretBase32: string, timestamp: number = Math.floor(Date.now() / 1000)): string {
  const secretBytes = base32Decode(secretBase32);

  // Calculate time counter (number of time steps since Unix epoch)
  const counter = Math.floor(timestamp / STEP_SECONDS);

  // Convert counter to 8-byte big-endian buffer
  const counterBuffer = Buffer.alloc(8);
  // Write as two 32-bit values to handle counters > 2^32
  counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuffer.writeUInt32BE(counter & 0xffffffff, 4);

  // HMAC-SHA1
  const hmac = createHmac(ALGORITHM, secretBytes);
  hmac.update(counterBuffer);
  const hmacResult = hmac.digest();

  // Dynamic truncation (RFC 4226)
  const offset = hmacResult[hmacResult.length - 1] & 0x0f;
  const truncated = (
    ((hmacResult[offset] & 0x7f) << 24) |
    ((hmacResult[offset + 1] & 0xff) << 16) |
    ((hmacResult[offset + 2] & 0xff) << 8) |
    (hmacResult[offset + 3] & 0xff)
  );

  // Extract 6 digits
  const code = truncated % Math.pow(10, DIGITS);
  return code.toString().padStart(DIGITS, '0');
}

/**
 * Verify a TOTP code against the secret.
 *
 * Allows a configurable window to account for clock drift.
 * A window of 1 means accept codes from the previous, current, and next time step.
 *
 * @param secretBase32 - Base32-encoded secret
 * @param token - 6-digit code to verify
 * @param window - Number of time steps before/after to accept (default: 1)
 * @param timestamp - Unix timestamp in seconds (default: now)
 * @returns true if the code is valid within the window
 */
export function verifyTOTP(
  secretBase32: string,
  token: string,
  window: number = 1,
  timestamp: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!token || token.length !== DIGITS) {
    return false;
  }

  const counter = Math.floor(timestamp / STEP_SECONDS);

  // Check current, previous, and next time steps
  for (let i = -window; i <= window; i++) {
    const expectedCode = generateTOTP(secretBase32, (counter + i) * STEP_SECONDS);
    if (timingSafeEqualInt(expectedCode, token)) {
      return true;
    }
  }

  return false;
}

/**
 * Generate an otpauth:// URI for QR code generation.
 * This URI can be encoded as a QR code that authenticator apps can scan.
 *
 * @param secretBase32 - Base32-encoded secret
 * @param accountName - User's account name (typically email)
 * @param issuer - Service name (e.g., "Teros")
 * @returns otpauth:// URI string
 */
export function generateOTPAuthURI(
  secretBase32: string,
  accountName: string,
  issuer: string = 'Teros',
): string {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: DIGITS.toString(),
    period: STEP_SECONDS.toString(),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Generate a set of one-time-use backup codes.
 * These are 8-character alphanumeric codes that can be used
 * when the user loses access to their TOTP device.
 *
 * @param count - Number of backup codes to generate (default: 10)
 * @returns Array of backup code strings
 */
export function generateBackupCodes(count: number = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    // Generate 8-character code in format XXXX-XXXX
    const bytes = randomBytes(4);
    const hex = bytes.toString('hex').toUpperCase();
    codes.push(`${hex.slice(0, 4)}-${hex.slice(4, 8)}`);
  }
  return codes;
}

// ============================================================================
// BASE32 ENCODING/DECODING (RFC 4648)
// ============================================================================

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Encode bytes to base32 string
 */
function base32Encode(bytes: Buffer): string {
  let result = '';
  let buffer = 0;
  let bitsLeft = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bitsLeft += 8;
    while (bitsLeft >= 5) {
      const index = (buffer >> (bitsLeft - 5)) & 0x1f;
      result += BASE32_ALPHABET[index];
      bitsLeft -= 5;
    }
  }

  if (bitsLeft > 0) {
    const index = (buffer << (5 - bitsLeft)) & 0x1f;
    result += BASE32_ALPHABET[index];
  }

  return result;
}

/**
 * Decode base32 string to bytes
 */
function base32Decode(str: string): Buffer {
  const cleaned = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bitsLeft = 0;

  for (const char of cleaned) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value === -1) continue;
    buffer = (buffer << 5) | value;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bytes.push((buffer >> (bitsLeft - 8)) & 0xff);
      bitsLeft -= 8;
    }
  }

  return Buffer.from(bytes);
}

/**
 * Timing-safe comparison of two integer strings.
 * Both are compared as fixed-length buffers to prevent timing attacks.
 */
function timingSafeEqualInt(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
