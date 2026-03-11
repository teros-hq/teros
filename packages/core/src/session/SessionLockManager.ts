/**
 * Session Lock Manager - Cloned from the previous implementation
 *
 * Prevents concurrent execution on the same session.
 * Replicates the previous implementation's SessionLock system.
 *
 *
 */

export class SessionLockManager {
  private locks = new Map<
    string,
    {
      controller: AbortController;
      created: number;
    }
  >();

  /**
   * Acquire lock for a session
   * the previous implementation: SessionLock.acquire({ sessionID })
   *
   * Returns a disposable lock handle with:
   * - signal: AbortSignal to pass to async operations
   * - abort(): Manual abort method
   * - [Symbol.dispose](): Auto-cleanup when leaving scope
   *
   * Usage:
   *   using lock = lockManager.acquire(sessionID)
   *   // ... do work with lock.signal ...
   *   // lock is automatically released when scope exits
   */
  acquire(sessionID: string): LockHandle {
    // Check if already locked
    const existing = this.locks.get(sessionID);
    if (existing) {
      throw new SessionLockedError(
        `Session ${sessionID} is locked (acquired ${Date.now() - existing.created}ms ago)`,
      );
    }

    // Create new lock
    const controller = new AbortController();
    this.locks.set(sessionID, {
      controller,
      created: Date.now(),
    });

    console.log(`🔒 Session locked: ${sessionID}`);

    // Return disposable handle
    return {
      signal: controller.signal,

      abort: () => {
        controller.abort();
        this.unset(sessionID, controller);
      },

      [Symbol.dispose]: () => {
        const removed = this.unset(sessionID, controller);
        if (removed) {
          console.log(`🔓 Session unlocked: ${sessionID}`);
        }
      },
    };
  }

  /**
   * Abort a session (force unlock and cancel operations)
   * the previous implementation: SessionLock.abort(sessionID)
   */
  abort(sessionID: string): boolean {
    const lock = this.locks.get(sessionID);
    if (!lock) {
      return false;
    }

    console.log(`🛑 Session aborted: ${sessionID}`);
    lock.controller.abort();
    this.locks.delete(sessionID);
    return true;
  }

  /**
   * Check if a session is currently locked
   * the previous implementation: SessionLock.isLocked(sessionID)
   */
  isBusy(sessionID: string): boolean {
    return this.locks.has(sessionID);
  }

  /**
   * Assert that a session is not locked (throws if locked)
   * the previous implementation: SessionLock.assertUnlocked(sessionID)
   */
  assertUnlocked(sessionID: string): void {
    const lock = this.locks.get(sessionID);
    if (lock) {
      throw new SessionLockedError(
        `Session ${sessionID} is locked (acquired ${Date.now() - lock.created}ms ago)`,
      );
    }
  }

  /**
   * Get lock info (for debugging)
   */
  getLockInfo(sessionID: string): { created: number; age: number } | null {
    const lock = this.locks.get(sessionID);
    if (!lock) return null;

    return {
      created: lock.created,
      age: Date.now() - lock.created,
    };
  }

  /**
   * Force unlock all sessions (for cleanup/shutdown)
   */
  unlockAll(): void {
    console.log(`🔓 Unlocking all sessions (${this.locks.size} locks)`);

    for (const [sessionID, lock] of this.locks) {
      lock.controller.abort();
      console.log(`  - Unlocked: ${sessionID}`);
    }

    this.locks.clear();
  }

  /**
   * Get all locked session IDs
   */
  getLockedSessions(): string[] {
    return Array.from(this.locks.keys());
  }

  /**
   * Internal: Remove lock if it matches the controller
   */
  private unset(sessionID: string, controller: AbortController): boolean {
    const lock = this.locks.get(sessionID);
    if (!lock) return false;
    if (lock.controller !== controller) return false;

    this.locks.delete(sessionID);
    return true;
  }
}

/**
 * Lock handle returned by acquire()
 * Uses Symbol.dispose for automatic cleanup with 'using' keyword
 */
export interface LockHandle {
  signal: AbortSignal;
  abort(): void;
  [Symbol.dispose](): void;
}

/**
 * Error thrown when trying to lock an already-locked session
 */
export class SessionLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionLockedError';
  }
}
