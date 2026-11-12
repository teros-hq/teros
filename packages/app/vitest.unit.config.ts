/// <reference types="vitest" />
import { defineConfig } from 'vitest/config'

/**
 * Unit test harness — pure logic tests, no DOM/RN-Web needed.
 *
 * Separate from vitest.config.ts (render tests with jsdom + RN-Web stubs)
 * to avoid the heavy Tamagui/RN-Web setup for simple unit tests.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 10000,
  },
})
