/**
 * MFA Service
 *
 * Manages TOTP-based Multi-Factor Authentication for users.
 * Handles:
 * - MFA setup (generate secret, return QR URI)
 * - MFA enable (verify first code, store secret)
 * - MFA disable (verify password or code)
 * - MFA verify (check TOTP code or backup code during login)
 * - Backup code generation and consumption
 *
 * Security notes:
 * - TOTP secrets are stored encrypted using the existing encryption module
 * - Backup codes are bcrypt-hashed (never stored in plaintext)
 * - MFA is required for admin/super accounts (Req 3.3.1)
 */

import * as bcrypt from 'bcrypt';
import { type Collection, type Db } from 'mongodb';
import { generateBackupCodes, generateOTPAuthURI, generateTOTPSecret, verifyTOTP } from './totp';
import type { User } from './types';
import { AAD_FORMAT, decryptForUser, encryptForUser } from './user-keys';

const TOTP_SCOPE = 'mfa_totp';

const BCRYPT_ROUNDS = 12;
const BACKUP_CODE_COUNT = 10;
const TOTP_WINDOW = 1; // Accept ±1 time step (±30s) for clock drift

export interface MFASetupResult {
  /** Base32-encoded TOTP secret (shown to user for manual entry) */
  secret: string;
  /** otpauth:// URI for QR code generation */
  otpauthURI: string;
  /** One-time-use backup codes (only shown once at setup time) */
  backupCodes: string[];
}

export interface MFAVerifyResult {
  success: boolean;
  /** True if a backup code was consumed (not a TOTP code) */
  usedBackupCode?: boolean;
  /** Remaining backup codes (if a backup code was used) */
  backupCodesRemaining?: number;
  error?: string;
}

export class MFAService {
  private users: Collection<User>;

  constructor(private db: Db) {
    this.users = db.collection<User>('users');
  }

  /**
   * Initialize MFA setup for a user.
   * Generates a new TOTP secret and backup codes but does NOT enable MFA yet.
   * The user must verify with a TOTP code via `enableMFA` to complete setup.
   *
   * @returns Setup result with secret, QR URI, and backup codes
   */
  async setupMFA(userId: string): Promise<MFASetupResult> {
    const user = await this.users.findOne({ userId, deletedAt: { $exists: false } });
    if (!user) {
      throw new Error('User not found');
    }

    // Generate new TOTP secret
    const secret = generateTOTPSecret();
    const otpauthURI = generateOTPAuthURI(secret, user.profile.email, 'Teros');
    const backupCodes = generateBackupCodes(BACKUP_CODE_COUNT);

    // Hash backup codes for storage
    const backupCodeHashes = await Promise.all(
      backupCodes.map((code) => bcrypt.hash(code, BCRYPT_ROUNDS)),
    );

    // Store MFA config with enabled=false (pending verification). The secret
    // is encrypted with the user's key (SEC-4).
    const secretEnc = await encryptForUser(this.db, userId, TOTP_SCOPE, secret);
    await this.users.updateOne(
      { userId },
      {
        $set: {
          mfa: {
            enabled: false,
            secretEnc,
            enabledAt: new Date(),
            backupCodeHashes,
            backupCodesRemaining: BACKUP_CODE_COUNT,
            backupCodesRegeneratedAt: new Date(),
          },
          updatedAt: new Date(),
        },
      },
    );

    return { secret, otpauthURI, backupCodes };
  }

  /**
   * The user's TOTP secret. A legacy plaintext one is encrypted in place on
   * first use (SEC-4).
   */
  private async totpSecret(user: User): Promise<string> {
    const mfa = user.mfa;
    if (!mfa) throw new Error('MFA not configured');
    if (mfa.secretEnc) return decryptForUser(this.db, user.userId, TOTP_SCOPE, mfa.secretEnc, AAD_FORMAT);
    const secret = mfa.secret;
    if (!secret) throw new Error('MFA secret missing');
    const secretEnc = await encryptForUser(this.db, user.userId, TOTP_SCOPE, secret);
    await this.users.updateOne(
      { userId: user.userId, 'mfa.secret': secret },
      { $set: { 'mfa.secretEnc': secretEnc }, $unset: { 'mfa.secret': '' } },
    );
    return secret;
  }

  /**
   * Enable MFA for a user after they verify with a TOTP code.
   * This completes the setup process — the user must have called setupMFA first.
   *
   * @param userId - User ID
   * @param totpCode - 6-digit TOTP code from the user's authenticator app
   * @returns true if MFA was enabled successfully
   */
  async enableMFA(userId: string, totpCode: string): Promise<boolean> {
    const user = await this.users.findOne({ userId, deletedAt: { $exists: false } });
    if (!user) {
      throw new Error('User not found');
    }

    if (!user.mfa) {
      throw new Error('MFA setup not initiated. Call setupMFA first.');
    }

    if (user.mfa.enabled) {
      throw new Error('MFA is already enabled');
    }

    // Verify the TOTP code
    if (!verifyTOTP(await this.totpSecret(user), totpCode, TOTP_WINDOW)) {
      return false;
    }

    // Enable MFA
    await this.users.updateOne(
      { userId },
      {
        $set: {
          'mfa.enabled': true,
          'mfa.enabledAt': new Date(),
          updatedAt: new Date(),
        },
      },
    );

    console.log(`[MFAService] MFA enabled for user ${userId}`);
    return true;
  }

  /**
   * Disable MFA for a user.
   * Requires either a valid TOTP code or a backup code for verification.
   *
   * @param userId - User ID
   * @param code - TOTP code or backup code
   * @returns true if MFA was disabled successfully
   */
  async disableMFA(userId: string, code: string): Promise<boolean> {
    const user = await this.users.findOne({ userId, deletedAt: { $exists: false } });
    if (!user) {
      throw new Error('User not found');
    }

    if (!user.mfa?.enabled) {
      throw new Error('MFA is not enabled');
    }

    // Verify with TOTP code or backup code
    const verified = verifyTOTP(await this.totpSecret(user), code, TOTP_WINDOW);
    if (!verified) {
      const backupResult = await this.tryBackupCode(user, code);
      if (!backupResult) {
        return false;
      }
    }

    // Remove MFA configuration
    await this.users.updateOne(
      { userId },
      {
        $unset: { mfa: '' },
        $set: { updatedAt: new Date() },
      },
    );

    console.log(`[MFAService] MFA disabled for user ${userId}`);
    return true;
  }

  /**
   * Verify a TOTP code or backup code during login.
   * If a backup code is used, it is consumed (removed from the list).
   *
   * @param userId - User ID
   * @param code - TOTP code or backup code
   * @returns Verification result
   */
  async verifyMFA(userId: string, code: string): Promise<MFAVerifyResult> {
    const user = await this.users.findOne({ userId, deletedAt: { $exists: false } });
    if (!user) {
      return { success: false, error: 'User not found' };
    }

    if (!user.mfa?.enabled) {
      return { success: false, error: 'MFA is not enabled for this user' };
    }

    // Try TOTP code first
    if (verifyTOTP(await this.totpSecret(user), code, TOTP_WINDOW)) {
      return { success: true };
    }

    // Try backup code
    const backupResult = await this.tryBackupCode(user, code);
    if (backupResult) {
      return {
        success: true,
        usedBackupCode: true,
        backupCodesRemaining: backupResult.remaining,
      };
    }

    return { success: false, error: 'Invalid TOTP code or backup code' };
  }

  /**
   * Check if MFA is enabled for a user.
   */
  async isMFAEnabled(userId: string): Promise<boolean> {
    const user = await this.users.findOne({ userId }, { projection: { mfa: 1 } });
    return user?.mfa?.enabled ?? false;
  }

  /**
   * Get MFA status for a user (for UI display).
   * Does NOT return the secret or backup codes.
   */
  async getMFAStatus(userId: string): Promise<{
    enabled: boolean;
    enabledAt?: Date;
    backupCodesRemaining: number;
  } | null> {
    const user = await this.users.findOne({ userId }, { projection: { mfa: 1 } });
    if (!user?.mfa) {
      return { enabled: false, backupCodesRemaining: 0 };
    }
    return {
      enabled: user.mfa.enabled,
      enabledAt: user.mfa.enabledAt,
      backupCodesRemaining: user.mfa.backupCodesRemaining,
    };
  }

  /**
   * Regenerate backup codes for a user.
   * Requires MFA to be enabled. Old backup codes are invalidated.
   *
   * @returns New backup codes (only shown once)
   */
  async regenerateBackupCodes(userId: string): Promise<string[]> {
    const user = await this.users.findOne({ userId, deletedAt: { $exists: false } });
    if (!user) {
      throw new Error('User not found');
    }

    if (!user.mfa?.enabled) {
      throw new Error('MFA is not enabled');
    }

    const newBackupCodes = generateBackupCodes(BACKUP_CODE_COUNT);
    const newHashes = await Promise.all(
      newBackupCodes.map((code) => bcrypt.hash(code, BCRYPT_ROUNDS)),
    );

    await this.users.updateOne(
      { userId },
      {
        $set: {
          'mfa.backupCodeHashes': newHashes,
          'mfa.backupCodesRemaining': BACKUP_CODE_COUNT,
          'mfa.backupCodesRegeneratedAt': new Date(),
          updatedAt: new Date(),
        },
      },
    );

    return newBackupCodes;
  }

  /**
   * Try to consume a backup code.
   * If the code matches one of the stored hashes, it is removed.
   *
   * @returns true if a backup code was consumed, false otherwise
   */
  private async tryBackupCode(
    user: User,
    code: string,
  ): Promise<{ remaining: number } | null> {
    if (!user.mfa?.backupCodeHashes?.length) {
      return null;
    }

    // Normalize: backup codes are case-insensitive, strip spaces
    const normalizedCode = code.toUpperCase().replace(/\s/g, '');

    // Compare against all hashes in parallel for performance.
    // Sequential bcrypt.compare with 12 rounds × 10 codes = ~3s; parallel = ~300ms.
    const hashes = user.mfa.backupCodeHashes;
    const compareResults = await Promise.all(
      hashes.map(
        (hash) =>
          bcrypt.compare(normalizedCode, hash).catch(() => false),
      ),
    );

    const matchIndex = compareResults.findIndex((matched) => matched === true);
    if (matchIndex === -1) {
      return null;
    }

    // Remove the used backup code
    const newHashes = [...hashes];
    newHashes.splice(matchIndex, 1);
    const remaining = newHashes.length;

    await this.users.updateOne(
      { userId: user.userId },
      {
        $set: {
          'mfa.backupCodeHashes': newHashes,
          'mfa.backupCodesRemaining': remaining,
          updatedAt: new Date(),
        },
      },
    );

    console.log(`[MFAService] Backup code used for user ${user.userId}, ${remaining} remaining`);
    return { remaining };
  }
}
