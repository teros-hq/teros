/**
 * Tests for the per-call permission-heuristics registry.
 *
 * The registry exists so polymorphic MCA tools (bash, exec, evaluate)
 * can decide irreversibility at render time based on actual input,
 * instead of relying on the static `annotations.irreversible` of the
 * manifest. These tests pin two contracts:
 *
 * 1. Registered tools delegate to the right per-domain helper.
 * 2. Unregistered tools fall back to `false` so the caller can OR with
 *    the static manifest flag without double-counting.
 *
 * And the fail-safe: a heuristic that throws never elevates the UI to
 * "irreversible: true" — better to miss a warning than show one for
 * the wrong call.
 */
import { describe, expect, it } from 'bun:test';

import {
  _registeredIrreversibilityKeys,
  isToolCallIrreversible,
} from '../../../../packages/app/src/components/mca/renderers/permission-heuristics';

describe('isToolCallIrreversible', () => {
  describe('mca.teros.bash:bash — delegates to isBashCommandIrreversible', () => {
    it('returns true for rm -rf', () => {
      expect(
        isToolCallIrreversible('mca.teros.bash', 'bash', { command: 'rm -rf /tmp/foo' }),
      ).toBe(true);
    });

    it('returns true for npm publish', () => {
      expect(isToolCallIrreversible('mca.teros.bash', 'bash', { command: 'npm publish' })).toBe(
        true,
      );
    });

    it('returns false for chmod 777 (reversible)', () => {
      expect(
        isToolCallIrreversible('mca.teros.bash', 'bash', { command: 'chmod -R 777 /tmp' }),
      ).toBe(false);
    });

    it('returns false for ls /tmp', () => {
      expect(isToolCallIrreversible('mca.teros.bash', 'bash', { command: 'ls /tmp' })).toBe(false);
    });

    it('returns false when input has no command field', () => {
      expect(isToolCallIrreversible('mca.teros.bash', 'bash', {})).toBe(false);
    });

    it('returns false when input is null/undefined', () => {
      expect(isToolCallIrreversible('mca.teros.bash', 'bash', null)).toBe(false);
      expect(isToolCallIrreversible('mca.teros.bash', 'bash', undefined)).toBe(false);
    });
  });

  describe('mca.teros.admin.bash:bash — same heuristic, separate key', () => {
    it('returns true for rm -rf', () => {
      expect(
        isToolCallIrreversible('mca.teros.admin.bash', 'bash', { command: 'rm -rf /' }),
      ).toBe(true);
    });

    it('returns false for ls /tmp', () => {
      expect(
        isToolCallIrreversible('mca.teros.admin.bash', 'bash', { command: 'ls /tmp' }),
      ).toBe(false);
    });
  });

  describe('unregistered tools — fallback to false', () => {
    it('returns false for a Linear delete (uses static manifest flag instead)', () => {
      // The manifest of mca.linear:delete-issue has
      // `annotations.irreversible: true` — caller should OR the static
      // prop with this function. Registry returns `false` because
      // there's no per-call decider needed.
      expect(isToolCallIrreversible('mca.linear', 'delete-issue', {})).toBe(false);
    });

    it('returns false for a totally unknown MCA', () => {
      expect(isToolCallIrreversible('mca.does-not-exist', 'whatever', {})).toBe(false);
    });

    it('returns false for the empty mcaId', () => {
      expect(isToolCallIrreversible('', 'bash', { command: 'rm -rf /' })).toBe(false);
    });
  });

  describe('fail-safe — heuristic errors return false', () => {
    it('does not throw when input is a non-object that the bash decider would crash on', () => {
      // The bash decider reads `input?.command`. Passing a string
      // makes `(input as any)?.command` undefined, not a crash. This
      // pins that the optional chaining + try/catch combo never
      // surfaces an exception to the renderer.
      expect(() => isToolCallIrreversible('mca.teros.bash', 'bash', 'not-an-object')).not.toThrow();
      expect(isToolCallIrreversible('mca.teros.bash', 'bash', 'not-an-object')).toBe(false);
    });

    it('does not throw on number, array, function input', () => {
      expect(() => isToolCallIrreversible('mca.teros.bash', 'bash', 42)).not.toThrow();
      expect(() => isToolCallIrreversible('mca.teros.bash', 'bash', [1, 2])).not.toThrow();
      expect(() => isToolCallIrreversible('mca.teros.bash', 'bash', () => {})).not.toThrow();
    });
  });

  describe('_registeredIrreversibilityKeys — test introspection', () => {
    it('covers both bash variants', () => {
      const keys = _registeredIrreversibilityKeys();
      expect(keys).toContain('mca.teros.bash:bash');
      expect(keys).toContain('mca.teros.admin.bash:bash');
    });
  });
});
