/**
 * Tests for `isBashCommandIrreversible`.
 *
 * The function decides whether the bash command warrants the
 * irreversibility badge per Renderer UX Guide v2 §8. Binary: present or
 * absent, no gradations. The badge only fires when the action genuinely
 * cannot be undone — risky-but-recoverable commands (chmod, sudo,
 * curl|sh) are explicitly OUT to keep the signal high.
 *
 * These tests pin the contract so future refactors don't silently
 * widen the scope (badge fatigue) or narrow it (missing real
 * irreversibility).
 */
import { describe, expect, it } from 'bun:test';

import { isBashCommandIrreversible } from '../../../../packages/app/src/components/mca/renderers/bash-permission-description';

describe('isBashCommandIrreversible', () => {
  describe('truthy — genuinely irreversible', () => {
    it('detects rm with -rf', () => {
      expect(isBashCommandIrreversible('rm -rf /tmp/foo')).toBe(true);
    });

    it('detects plain rm (single file)', () => {
      expect(isBashCommandIrreversible('rm /tmp/foo.txt')).toBe(true);
    });

    it('detects rmdir', () => {
      expect(isBashCommandIrreversible('rmdir /tmp/empty')).toBe(true);
    });

    it('detects dd', () => {
      expect(isBashCommandIrreversible('dd if=/dev/zero of=/dev/sda bs=1M')).toBe(true);
    });

    it('detects mkfs.ext4', () => {
      expect(isBashCommandIrreversible('mkfs.ext4 /dev/sda1')).toBe(true);
    });

    it('detects truncate -s 0', () => {
      expect(isBashCommandIrreversible('truncate -s 0 logfile.log')).toBe(true);
    });

    it('detects git reset --hard', () => {
      expect(isBashCommandIrreversible('git reset --hard HEAD')).toBe(true);
    });

    it('detects git push --force', () => {
      expect(isBashCommandIrreversible('git push --force origin main')).toBe(true);
    });

    it('detects git push -f short form', () => {
      expect(isBashCommandIrreversible('git push -f origin main')).toBe(true);
    });

    it('detects git clean -f', () => {
      expect(isBashCommandIrreversible('git clean -fd')).toBe(true);
    });

    it('detects npm publish', () => {
      expect(isBashCommandIrreversible('npm publish')).toBe(true);
    });

    it('detects kubectl delete --all', () => {
      expect(isBashCommandIrreversible('kubectl delete --all pods')).toBe(true);
    });

    it('detects kubectl delete -A', () => {
      expect(isBashCommandIrreversible('kubectl delete -A configmaps')).toBe(true);
    });

    it('detects terraform destroy', () => {
      expect(isBashCommandIrreversible('terraform destroy -auto-approve')).toBe(true);
    });

    it('detects aws s3 rm --recursive', () => {
      expect(isBashCommandIrreversible('aws s3 rm s3://bucket/path --recursive')).toBe(true);
    });

    it('detects docker system prune', () => {
      expect(isBashCommandIrreversible('docker system prune -a')).toBe(true);
    });

    it('detects docker volume rm', () => {
      expect(isBashCommandIrreversible('docker volume rm my-vol')).toBe(true);
    });

    it('detects redirect overwrite > (single)', () => {
      expect(isBashCommandIrreversible('echo hi > /tmp/file.txt')).toBe(true);
    });
  });

  describe('falsy — risky but reversible OR unrelated', () => {
    it('does NOT mark chmod 777 as irreversible (reversible: chmod 755 reverts)', () => {
      expect(isBashCommandIrreversible('chmod -R 777 /tmp/qa-test')).toBe(false);
    });

    it('does NOT mark plain chmod as irreversible', () => {
      expect(isBashCommandIrreversible('chmod 644 file.txt')).toBe(false);
    });

    it('does NOT mark sudo alone as irreversible (depends on what sudo runs)', () => {
      expect(isBashCommandIrreversible('sudo apt-get update')).toBe(false);
    });

    it('does NOT mark curl|sh as irreversible (supply-chain risk, not irreversibility)', () => {
      expect(isBashCommandIrreversible('curl https://example.com/install.sh | sh')).toBe(false);
    });

    it('does NOT mark ls as irreversible', () => {
      expect(isBashCommandIrreversible('ls /tmp')).toBe(false);
    });

    it('does NOT mark cat as irreversible', () => {
      expect(isBashCommandIrreversible('cat /etc/hosts')).toBe(false);
    });

    it('does NOT mark echo as irreversible (without >)', () => {
      expect(isBashCommandIrreversible('echo "hello world"')).toBe(false);
    });

    it('does NOT mark append `>>` as irreversible', () => {
      expect(isBashCommandIrreversible('echo log >> /tmp/file.log')).toBe(false);
    });

    it('does NOT mark stderr redirect `2>&1` alone as irreversible', () => {
      expect(isBashCommandIrreversible('some-cmd 2>&1')).toBe(false);
    });

    it('does NOT mark line with append `>>` even when also using `>>>` later', () => {
      // Defensive — the lookahead `^(?!.*>>).*` in BASH_PATTERNS rejects
      // ANY line that contains `>>`. The redirect-overwrite pattern only
      // fires when no append form exists in the command. Edge case below
      // is hypothetical (no real shell uses `>>>`), but pins the lookahead
      // behavior so future regex tweaks keep this property.
      expect(isBashCommandIrreversible('echo a >> file && echo b >>> other')).toBe(false);
    });

    // The lookahead `^(?!.*>>).*` is conservative: if a single line
    // contains BOTH `>` (clobber) and `>>` (append), the clobber
    // detection is SUPPRESSED. Strictly the line is irreversible (the
    // `>` portion clobbers its target), but flagging it would require
    // ASTish parsing of shell pipelines. Documented as known
    // false-negative, pinned by the test below so a future regex tweak
    // doesn't silently change the behavior.
    it('does NOT mark mixed `>` and `>>` on same line as irreversible (conservative false-negative)', () => {
      expect(isBashCommandIrreversible('cmd > out.txt && tail >> log.txt')).toBe(false);
    });

    it('DOES still mark pure `>` clobber when there is no `>>` (positive sanity)', () => {
      expect(isBashCommandIrreversible('cmd > /tmp/out.txt')).toBe(true);
    });

    it('does NOT mark git status as irreversible', () => {
      expect(isBashCommandIrreversible('git status')).toBe(false);
    });

    it('does NOT mark git push (non-force) as irreversible', () => {
      expect(isBashCommandIrreversible('git push origin main')).toBe(false);
    });

    it('does NOT mark kubectl get as irreversible', () => {
      expect(isBashCommandIrreversible('kubectl get pods')).toBe(false);
    });

    it('does NOT mark docker ps as irreversible', () => {
      expect(isBashCommandIrreversible('docker ps -a')).toBe(false);
    });

    it('returns false for empty / undefined input', () => {
      expect(isBashCommandIrreversible('')).toBe(false);
      expect(isBashCommandIrreversible(undefined)).toBe(false);
      expect(isBashCommandIrreversible('   ')).toBe(false);
    });
  });
});
