/**
 * Unit tests for the shared admin gates (`requireSystemAdmin`, `requireSuperAdmin`).
 * These are the canonical authorization checks the admin-api handlers sit behind
 * (TER-447). The structural invariant proves every handler CALLS a gate; this
 * proves the gate itself ACCEPTS/REJECTS the right roles.
 */
import { describe, expect, it } from 'bun:test';
import {
  requireSuperAdmin,
  requireSystemAdmin,
} from '../../../packages/backend/src/auth/auth-helpers';

/** Minimal db whose `users` collection returns a user with the given role
 * (or null for "no such user"). */
function dbWithRole(role: string | null): any {
  return {
    collection: () => ({
      findOne: async () => (role === null ? null : { userId: 'u1', role }),
    }),
  };
}

describe('requireSystemAdmin — role ∈ {admin, super}', () => {
  it('passes for an admin', async () => {
    await expect(requireSystemAdmin(dbWithRole('admin'), 'u1')).resolves.toBeUndefined();
  });

  it('passes for a super', async () => {
    await expect(requireSystemAdmin(dbWithRole('super'), 'u1')).resolves.toBeUndefined();
  });

  it('rejects a plain user with FORBIDDEN', async () => {
    await expect(requireSystemAdmin(dbWithRole('user'), 'u1')).rejects.toThrow(
      /Admin privileges required/,
    );
  });

  it('rejects an unknown user', async () => {
    await expect(requireSystemAdmin(dbWithRole(null), 'u1')).rejects.toThrow(
      /Admin privileges required/,
    );
  });
});

describe('requireSuperAdmin — role === super only', () => {
  it('passes for a super', async () => {
    await expect(requireSuperAdmin(dbWithRole('super'), 'u1')).resolves.toBeUndefined();
  });

  it('rejects an admin (not super) with FORBIDDEN', async () => {
    await expect(requireSuperAdmin(dbWithRole('admin'), 'u1')).rejects.toThrow(
      /Super admin privileges required/,
    );
  });

  it('rejects a plain user', async () => {
    await expect(requireSuperAdmin(dbWithRole('user'), 'u1')).rejects.toThrow(
      /Super admin privileges required/,
    );
  });
});
