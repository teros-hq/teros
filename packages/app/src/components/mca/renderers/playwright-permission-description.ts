/**
 * Permission description heuristics for browser-evaluation tools:
 *   • `mca.teros.playwright:browser-run-code`
 *   • `mca.teros.playwright:browser-evaluate`
 *   • `mca.browserbase:evaluate`
 *
 * The input is a JavaScript snippet that runs inside the page context.
 * Unlike bash, the destructive surface is browser-shaped: client-side
 * storage (`localStorage`, `sessionStorage`, IndexedDB, cookies), DOM
 * mutations that destroy user data (form.submit on destructive forms,
 * document.write that nukes the page), and the classic JS-injection
 * vectors (`eval`, `Function()`, `document.write`).
 *
 * Most page interactions are NOT destructive — querying selectors,
 * filling inputs, taking screenshots all leave state recoverable on
 * reload. The heuristic fires only on idioms that ERASE local state
 * or that load arbitrary code at runtime.
 *
 * What activates `irreversible`:
 *   • `localStorage.clear()` / `sessionStorage.clear()` — wipes app
 *     state with no undo.
 *   • `localStorage.removeItem('...')` / `sessionStorage.removeItem('...')`
 *     — partial wipe; still no undo path.
 *   • `indexedDB.deleteDatabase(...)` — drops an entire DB.
 *   • `document.cookie = 'name=; expires=Thu, 01 Jan 1970...'` — cookie
 *     deletion pattern.
 *
 * What activates `risk` (security/blast):
 *   • `eval(...)` — arbitrary code execution from string.
 *   • `new Function('...')(...)` — same.
 *   • `document.write(...)` — can replace the document.
 *   • `fetch('http://...')` (non-https) — mixed content / supply chain.
 *
 * Patterns are intentionally conservative — false negatives are
 * preferable to false positives when the heuristic is built on regex
 * over JS source.
 */

export interface PlaywrightCodeInput {
  code?: string;
  expression?: string;
  script?: string;
}

function extractCode(input: PlaywrightCodeInput | undefined): string {
  if (!input) return '';
  return (input.code ?? input.expression ?? input.script ?? '').trim();
}

export function isPlaywrightCodeIrreversible(input: PlaywrightCodeInput | undefined): boolean {
  const code = extractCode(input);
  if (!code) return false;

  // localStorage / sessionStorage destructive APIs.
  if (/\b(localStorage|sessionStorage)\s*\.\s*clear\s*\(/.test(code)) return true;
  if (/\b(localStorage|sessionStorage)\s*\.\s*removeItem\s*\(/.test(code)) return true;

  // IndexedDB.
  if (/\bindexedDB\s*\.\s*deleteDatabase\s*\(/.test(code)) return true;

  // Cookie deletion (expiry in the past). The cookie string itself
  // contains `;` separators, so the regex tolerates them between the
  // assignment and the `expires=` directive.
  if (/document\s*\.\s*cookie\s*=\s*['"`][^'"`]*expires=[^'"`]*1970/.test(code)) return true;

  return false;
}

export function isPlaywrightElevatedRisk(input: PlaywrightCodeInput | undefined): boolean {
  const code = extractCode(input);
  if (!code) return false;

  // eval / Function.
  if (/(^|[^.\w])eval\s*\(/.test(code)) return true;
  if (/new\s+Function\s*\(/.test(code)) return true;

  // document.write — can replace document.
  if (/document\s*\.\s*write(ln)?\s*\(/.test(code)) return true;

  // Non-HTTPS fetch (mixed-content / supply chain).
  if (/\bfetch\s*\(\s*['"`]http:\/\//.test(code)) return true;

  return false;
}
