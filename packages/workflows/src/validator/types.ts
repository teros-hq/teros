/**
 * Validator Types
 *
 * Result types returned by the gate validation functions.
 */

/**
 * Result of validating data against a gate.
 *
 * - `valid` — whether the data satisfies the gate's constraints
 * - `errors` — human-readable error messages (empty when valid)
 * - `variables` — for text gates with placeholders: the extracted variable values
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  /** Only populated for text gates with {{placeholder}} variables */
  variables?: Record<string, string>;
}
