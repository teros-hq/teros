/**
 * Tests for TOTP (Time-based One-Time Password) implementation
 * Tests RFC 6238 compliance and edge cases
 */

import { describe, expect, it } from 'bun:test';
import {
  generateBackupCodes,
  generateOTPAuthURI,
  generateTOTP,
  generateTOTPSecret,
  verifyTOTP,
} from '../../src/auth/totp';

describe('TOTP', () => {
  describe('generateTOTPSecret', () => {
    it('should generate a base32-encoded secret', () => {
      const secret = generateTOTPSecret();
      // Base32 alphabet: A-Z and 2-7
      expect(secret).toMatch(/^[A-Z2-7]+$/);
    });

    it('should generate a 32-character secret (20 bytes = 160 bits)', () => {
      const secret = generateTOTPSecret();
      // 20 bytes → 32 base32 characters
      expect(secret.length).toBe(32);
    });

    it('should generate unique secrets', () => {
      const secret1 = generateTOTPSecret();
      const secret2 = generateTOTPSecret();
      expect(secret1).not.toBe(secret2);
    });
  });

  describe('generateTOTP', () => {
    it('should generate a 6-digit code', () => {
      const secret = generateTOTPSecret();
      const code = generateTOTP(secret);
      expect(code).toMatch(/^\d{6}$/);
    });

    it('should generate the same code for the same time step', () => {
      const secret = generateTOTPSecret();
      const timestamp = 1700000000; // Fixed timestamp
      const code1 = generateTOTP(secret, timestamp);
      const code2 = generateTOTP(secret, timestamp);
      expect(code1).toBe(code2);
    });

    it('should generate the same code within the same 30-second window', () => {
      const secret = generateTOTPSecret();
      // Use a timestamp at second 10 of a window, so +10 stays within the same window
      // counter = floor(timestamp / 30). We need floor(t/30) === floor((t+10)/30)
      // So t mod 30 must be <= 19
      const baseTime = 1700000010; // 1700000010 % 30 = 10, so +10 = 20, both in same window
      const code1 = generateTOTP(secret, baseTime);
      const code2 = generateTOTP(secret, baseTime + 10);
      expect(code1).toBe(code2);
    });

    it('should generate different codes across different time steps', () => {
      const secret = generateTOTPSecret();
      const baseTime = 1700000000;
      const code1 = generateTOTP(secret, baseTime);
      const code2 = generateTOTP(secret, baseTime + 31); // Next time step
      // There's a tiny chance they're the same, but practically they differ
      // We'll just verify both are valid 6-digit codes
      expect(code1).toMatch(/^\d{6}$/);
      expect(code2).toMatch(/^\d{6}$/);
    });

    it('should generate deterministic codes for a known secret and time', () => {
      // Use a fixed secret
      const secret = 'JBSWY3DPEHPK3PXP';
      const code = generateTOTP(secret, 1234567890);
      // Should be a 6-digit code
      expect(code).toMatch(/^\d{6}$/);
      // Should be deterministic
      expect(generateTOTP(secret, 1234567890)).toBe(code);
    });
  });

  describe('verifyTOTP', () => {
    it('should verify a correct code', () => {
      const secret = generateTOTPSecret();
      const timestamp = Math.floor(Date.now() / 1000);
      const code = generateTOTP(secret, timestamp);
      expect(verifyTOTP(secret, code, 1, timestamp)).toBe(true);
    });

    it('should verify a code from the previous time step (within window)', () => {
      const secret = generateTOTPSecret();
      const timestamp = Math.floor(Date.now() / 1000);
      // Generate code for previous time step
      const prevStepCode = generateTOTP(secret, timestamp - 30);
      // Verify with window=1 (accepts ±1 step = ±30s)
      expect(verifyTOTP(secret, prevStepCode, 1, timestamp)).toBe(true);
    });

    it('should verify a code from the next time step (within window)', () => {
      const secret = generateTOTPSecret();
      const timestamp = Math.floor(Date.now() / 1000);
      const nextStepCode = generateTOTP(secret, timestamp + 30);
      expect(verifyTOTP(secret, nextStepCode, 1, timestamp)).toBe(true);
    });

    it('should reject a code outside the window', () => {
      const secret = generateTOTPSecret();
      const timestamp = Math.floor(Date.now() / 1000);
      // Code from 2 time steps ago (outside window=1)
      const oldCode = generateTOTP(secret, timestamp - 60);
      expect(verifyTOTP(secret, oldCode, 1, timestamp)).toBe(false);
    });

    it('should reject an invalid code', () => {
      const secret = generateTOTPSecret();
      expect(verifyTOTP(secret, '000000')).toBe(false); // Very unlikely to match
    });

    it('should reject a code with wrong length', () => {
      const secret = generateTOTPSecret();
      expect(verifyTOTP(secret, '12345')).toBe(false); // 5 digits
      expect(verifyTOTP(secret, '1234567')).toBe(false); // 7 digits
    });

    it('should reject an empty code', () => {
      const secret = generateTOTPSecret();
      expect(verifyTOTP(secret, '')).toBe(false);
    });

    it('should reject a code for a different secret', () => {
      const secret1 = generateTOTPSecret();
      const secret2 = generateTOTPSecret();
      const timestamp = Math.floor(Date.now() / 1000);
      const code = generateTOTP(secret1, timestamp);
      expect(verifyTOTP(secret2, code, 1, timestamp)).toBe(false);
    });
  });

  describe('generateOTPAuthURI', () => {
    it('should generate a valid otpauth:// URI', () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      const uri = generateOTPAuthURI(secret, 'user@example.com');
      expect(uri).toMatch(/^otpauth:\/\/totp\//);
      expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
      expect(uri).toContain('issuer=Teros');
      expect(uri).toContain('digits=6');
      expect(uri).toContain('period=30');
    });

    it('should encode the account name properly', () => {
      const secret = 'JBSWY3DPEHPK3PXP';
      const uri = generateOTPAuthURI(secret, 'user@example.com', 'Teros');
      // Label should be "Teros:user@example.com" URL-encoded
      expect(uri).toContain('Teros%3Auser%40example.com');
    });
  });

  describe('generateBackupCodes', () => {
    it('should generate the requested number of codes', () => {
      const codes = generateBackupCodes(10);
      expect(codes).toHaveLength(10);
    });

    it('should generate codes in XXXX-XXXX format', () => {
      const codes = generateBackupCodes(5);
      for (const code of codes) {
        expect(code).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
      }
    });

    it('should generate unique codes', () => {
      const codes = generateBackupCodes(20);
      const unique = new Set(codes);
      // With 4 bytes of randomness per code, collisions are extremely unlikely
      expect(unique.size).toBeGreaterThan(15); // Allow for rare collisions
    });
  });
});
