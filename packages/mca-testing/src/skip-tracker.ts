/**
 * Tracks conditional test skips and fails the suite if too many
 * valuable tests were silently skipped (TESTING-QUALITY §7:
 * "suite drifted en verde-falso").
 */
export class SkipTracker {
  private skips: string[] = [];
  private maxAllowed: number;

  constructor(maxAllowed = 3) {
    this.maxAllowed = maxAllowed;
  }

  skip(testName: string, reason: string): void {
    this.skips.push(`${testName}: ${reason}`);
    console.log(`[SKIP] ${testName}: ${reason}`);
  }

  assertNotTooManySkips(): void {
    if (this.skips.length > this.maxAllowed) {
      throw new Error(
        `Too many skipped tests (${this.skips.length}/${this.maxAllowed}):\n` +
          this.skips.map((s) => `  - ${s}`).join('\n'),
      );
    }
  }

  getSkippedCount(): number {
    return this.skips.length;
  }

  getSkipped(): string[] {
    return [...this.skips];
  }
}
