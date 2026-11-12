/**
 * Tests for step-up authentication (Req 2.4.1)
 *
 * Verifies that:
 * - SessionService.setStepUp / hasValidStepUp work correctly
 * - The requireStepUp guard throws STEP_UP_REQUIRED when no step-up is present
 * - The requireStepUp guard passes when a valid step-up exists
 * - Expired step-up (older than STEP_UP_WINDOW_MS) is rejected
 */

import { describe, expect, it } from 'bun:test'
import { SessionService, STEP_UP_WINDOW_MS } from '../../../auth/session-service'
import { requireStepUp } from './require-step-up'
import { HandlerError } from '../../../ws-framework/WsRouter'
import type { WsHandlerContext } from '@teros/shared'
import type { UserSession } from '../../../auth/types'
import { ObjectId } from 'mongodb'

// Minimal mock — we only test the pure logic paths (hasValidStepUp + requireStepUp guard)
// Full integration tests with MongoDB are in the auth-manager test suite.

describe('Step-up authentication (Req 2.4.1)', () => {
  describe('SessionService.hasValidStepUp', () => {
    // We test the pure logic by creating a SessionService with a mock db
    // and calling hasValidStepUp directly with a session object.
    const mockDb = { collection: () => ({}) } as any
    const sessionService = new SessionService(mockDb)

    it('returns false when session has no stepUpAt', () => {
      const session: UserSession = {
        _id: new ObjectId(),
        userId: 'user:test',
        identityId: new ObjectId(),
        tokenHash: 'abc',
        metadata: {},
        expiresAt: new Date(Date.now() + 86400000),
        status: 'active',
        createdAt: new Date(),
        lastActivityAt: new Date(),
      }
      expect(sessionService.hasValidStepUp(session)).toBe(false)
    })

    it('returns true when stepUpAt is recent (within window)', () => {
      const session: UserSession = {
        _id: new ObjectId(),
        userId: 'user:test',
        identityId: new ObjectId(),
        tokenHash: 'abc',
        metadata: {
          stepUpAt: new Date(Date.now() - 60_000), // 1 minute ago
        },
        expiresAt: new Date(Date.now() + 86400000),
        status: 'active',
        createdAt: new Date(),
        lastActivityAt: new Date(),
      }
      expect(sessionService.hasValidStepUp(session)).toBe(true)
    })

    it('returns false when stepUpAt is older than STEP_UP_WINDOW_MS', () => {
      const session: UserSession = {
        _id: new ObjectId(),
        userId: 'user:test',
        identityId: new ObjectId(),
        tokenHash: 'abc',
        metadata: {
          stepUpAt: new Date(Date.now() - STEP_UP_WINDOW_MS - 1000), // just expired
        },
        expiresAt: new Date(Date.now() + 86400000),
        status: 'active',
        createdAt: new Date(),
        lastActivityAt: new Date(),
      }
      expect(sessionService.hasValidStepUp(session)).toBe(false)
    })

    it('returns false when stepUpAt is in the future (tampered)', () => {
      const session: UserSession = {
        _id: new ObjectId(),
        userId: 'user:test',
        identityId: new ObjectId(),
        tokenHash: 'abc',
        metadata: {
          stepUpAt: new Date(Date.now() + 60000), // 1 minute in future
        },
        expiresAt: new Date(Date.now() + 86400000),
        status: 'active',
        createdAt: new Date(),
        lastActivityAt: new Date(),
      }
      // The elapsed would be negative, so elapsed >= 0 fails → false
      expect(sessionService.hasValidStepUp(session)).toBe(false)
    })
  })

  describe('requireStepUp guard', () => {
    it('throws STEP_UP_REQUIRED when sessionToken is missing', async () => {
      const mockSessionService = {
        getByTokenHash: async () => null,
        hasValidStepUp: () => false,
      } as any as SessionService

      const ctx: WsHandlerContext = {
        userId: 'user:test',
        sessionId: 'session:test',
        ip: '127.0.0.1',
        // no sessionToken
      }

      await expect(requireStepUp(ctx, mockSessionService)).rejects.toThrow(HandlerError)
      try {
        await requireStepUp(ctx, mockSessionService)
      } catch (e) {
        expect((e as HandlerError).code).toBe('STEP_UP_REQUIRED')
      }
    })

    it('throws STEP_UP_REQUIRED when session has no step-up', async () => {
      const mockSession: UserSession = {
        _id: new ObjectId(),
        userId: 'user:test',
        identityId: new ObjectId(),
        tokenHash: 'abc',
        metadata: {},
        expiresAt: new Date(Date.now() + 86400000),
        status: 'active',
        createdAt: new Date(),
        lastActivityAt: new Date(),
      }

      const mockSessionService = {
        getByTokenHash: async () => mockSession,
        hasValidStepUp: () => false,
      } as any as SessionService

      const ctx: WsHandlerContext = {
        userId: 'user:test',
        sessionId: 'session:test',
        ip: '127.0.0.1',
        sessionToken: 'test-token',
      }

      try {
        await requireStepUp(ctx, mockSessionService)
        expect.fail('Should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(HandlerError)
        expect((e as HandlerError).code).toBe('STEP_UP_REQUIRED')
      }
    })

    it('passes silently when session has valid step-up', async () => {
      const mockSession: UserSession = {
        _id: new ObjectId(),
        userId: 'user:test',
        identityId: new ObjectId(),
        tokenHash: 'abc',
        metadata: {
          stepUpAt: new Date(Date.now() - 60_000),
        },
        expiresAt: new Date(Date.now() + 86400000),
        status: 'active',
        createdAt: new Date(),
        lastActivityAt: new Date(),
      }

      const mockSessionService = {
        getByTokenHash: async () => mockSession,
        hasValidStepUp: () => true,
      } as any as SessionService

      const ctx: WsHandlerContext = {
        userId: 'user:test',
        sessionId: 'session:test',
        ip: '127.0.0.1',
        sessionToken: 'test-token',
      }

      // Should not throw
      await requireStepUp(ctx, mockSessionService)
    })
  })
})
