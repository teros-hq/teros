import { expect } from 'bun:test';
import type { McaToolResultResponse, McaToolsListResponse } from '@teros/shared';

export function expectToolSuccess(response: McaToolResultResponse): void {
  expect(response.success).toBe(true);
  expect(response.error).toBeUndefined();
}

export function expectToolError(
  response: McaToolResultResponse,
  errorCode?: string,
): void {
  expect(response.success).toBe(false);
  expect(response.error).toBeDefined();
  if (errorCode) {
    expect(response.error!.code).toBe(errorCode);
  }
}

export function expectToolsInclude(
  response: McaToolsListResponse,
  toolNames: string[],
): void {
  const names = response.tools.map((t) => t.name);
  for (const name of toolNames) {
    expect(names).toContain(name);
  }
}

type FieldType = 'string' | 'number' | 'boolean' | 'array' | 'object';

export function expectToolResponseShape(
  response: McaToolResultResponse,
  shape: Record<string, FieldType>,
): void {
  expectToolSuccess(response);
  const result = response.result as Record<string, unknown>;
  for (const [key, expectedType] of Object.entries(shape)) {
    expect(result).toHaveProperty(key);
    if (expectedType === 'array') {
      expect(Array.isArray(result[key])).toBe(true);
    } else {
      expect(typeof result[key]).toBe(expectedType);
    }
  }
}

export function expectToolsExact(
  response: McaToolsListResponse,
  toolNames: string[],
): void {
  const actual = response.tools.map((t) => t.name).sort();
  const expected = [...toolNames].sort();
  expect(actual).toEqual(expected);
}
