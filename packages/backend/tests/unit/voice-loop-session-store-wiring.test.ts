/**
 * Wiring guard — VoiceLoop.setSessionStore must be CALLED by server-bootstrap.
 *
 * task_2c87e848dd2e4161 (second round): the overheard → session_messages mirror
 * shipped complete (setter + persistOverheardToSessionStore + call in the gate's
 * overheard branch) but the bootstrap never wired the store into the loop, so
 * the mirror's `if (!this.sessionStore) return` silently no-oped in production
 * — overheard kept missing from the LLM context of text turns. The unit suites
 * passed because they wire the store themselves.
 *
 * This test reads the bootstrap SOURCE (pattern: agent-usage-wiring.test.ts):
 * the VoiceLoop construction block must contain the setSessionStore call. If
 * the wiring is removed — or the block is refactored away — this goes red
 * before the silent data loss can ship again.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";

const BOOTSTRAP = resolve(__dirname, "../../src/bootstrap/server-bootstrap.ts");

function source(): string {
  return readFileSync(BOOTSTRAP, "utf-8");
}

/**
 * The `const voiceLoop = new VoiceLoop(...)` wiring block, up to the next
 * section banner. Both voice engines (loop + legacy handler) are wired inside
 * it, so one slice covers both assertions.
 */
function voiceLoopBlock(src: string): string | null {
  const start = src.indexOf("const voiceLoop = new VoiceLoop(");
  if (start === -1) return null;
  const rest = src.slice(start);
  const end = rest.indexOf("\n  // ---------");
  return end === -1 ? rest : rest.slice(0, end);
}

describe("VoiceLoop session-store wiring (overheard → LLM context, task_2c87e848dd2e4161)", () => {
  it("server-bootstrap wires the session store into the VoiceLoop", () => {
    const block = voiceLoopBlock(source());
    expect(block).not.toBeNull();
    expect(block).toMatch(/voiceLoop\.setSessionStore\(\s*sessionStore\s*\)/);
  });

  it("the legacy VoiceHandler keeps its own wiring (both engines mirror into session_messages)", () => {
    // The legacy handler is wired just BEFORE the VoiceLoop block (AF-5), so
    // this one asserts against the whole bootstrap source.
    expect(source()).toMatch(/voiceHandler\.setSessionStore\(\s*sessionStore\s*\)/);
  });
});
