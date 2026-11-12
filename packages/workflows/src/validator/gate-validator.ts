/**
 * Gate Validator — Artifact Schema-Based Validation
 *
 * Validates data against a Gate definition. In the Flowing model, gates reference
 * Artifacts via schemaId. The validator resolves the artifact's schema and validates
 * the data against it.
 *
 * A gate can have:
 * - schemaId referencing an Artifact with an ArtifactSchema (property-based)
 * - schemaId: null → signal-only gate (no data, just control flow)
 *
 * The validator accepts the resolved ArtifactSchema directly (the engine/caller
 * is responsible for resolving schemaId → Artifact → ArtifactSchema). This keeps
 * the validator decoupled from the database.
 *
 * If the gate is signal-only (schemaId === null), validation always passes —
 * the gate carries no data.
 *
 * Design doc: /opt/teros/docs/workflows/DESIGN.md
 */

import type { Gate, ArtifactSchema } from '../models/types';
import type { ValidationResult } from './types';
import { validateArtifactSchema } from './json-validator';

/**
 * Get a human-readable label for a gate (for error messages).
 */
function gateLabel(gate: Gate): string {
  return gate.label ?? gate.gateId;
}

/**
 * Validate data against a gate definition.
 *
 * @param gate - The gate to validate against (schemaId, label)
 * @param data - The data to validate
 * @param resolvedSchema - The ArtifactSchema resolved from the gate's schemaId
 *                         (required when schemaId is non-null)
 * @returns ValidationResult with `valid` and `errors`
 *
 * @example
 * // Gate referencing a "Lead" artifact
 * const gate: Gate = {
 *   gateId: 'gate_1',
 *   schemaId: 'art_lead123',
 *   label: 'Lead Input',
 * };
 * const schema: ArtifactSchema = {
 *   name: 'Lead',
 *   title: 'Lead',
 *   type: 'object',
 *   properties: {
 *     name: { name: 'name', type: 'text', required: true },
 *     email: { name: 'email', type: 'text', required: true, pattern: '^[^@]+@[^@]+\\.[^@]+$' },
 *   },
 * };
 * const result = validateGate(gate, { name: 'John', email: 'john@example.com' }, schema);
 * // result.valid === true
 *
 * @example
 * // Signal-only gate (no data)
 * const signalGate: Gate = { gateId: 'gate_2', schemaId: null };
 * const result = validateGate(signalGate, undefined, undefined);
 * // result.valid === true (signal-only gates always pass)
 */
export function validateGate(
  gate: Gate,
  data: unknown,
  resolvedSchema?: ArtifactSchema | null,
): ValidationResult {
  // Signal-only gate — no data, always valid
  if (gate.schemaId === null) {
    return { valid: true, errors: [] };
  }

  // Gate references an artifact but no schema was resolved
  if (!resolvedSchema) {
    return {
      valid: false,
      errors: [
        `Gate "${gateLabel(gate)}" references schemaId "${gate.schemaId}" but no schema was resolved`,
      ],
    };
  }

  // Null/undefined data with a non-null schemaId
  if (data === null || data === undefined) {
    return {
      valid: false,
      errors: [
        `Gate "${gateLabel(gate)}" expects data matching artifact "${resolvedSchema.name}" but got ${data === null ? 'null' : 'undefined'}`,
      ],
    };
  }

  // Validate data against the artifact schema
  const result = validateArtifactSchema(data, resolvedSchema);

  if (!result.valid) {
    // Prefix errors with the gate label for better context
    const prefixedErrors = result.errors.map(
      (err) => `Gate "${gateLabel(gate)}" (artifact: ${resolvedSchema.name}): ${err}`,
    );
    return { valid: false, errors: prefixedErrors };
  }

  return result;
}

/**
 * Validate multiple gates at once.
 *
 * Useful for validating all input gates or all output gates of a node.
 * Returns aggregated errors from all gates that fail.
 *
 * @param gates - Array of gates to validate
 * @param dataMap - Map of gateId → data
 * @param schemaMap - Map of schemaId → ArtifactSchema (for resolving gate schemas)
 * @returns ValidationResult (aggregated — all errors from all gates)
 */
export function validateGates(
  gates: Gate[],
  dataMap: Record<string, unknown>,
  schemaMap?: Map<string, ArtifactSchema> | null,
): ValidationResult {
  const allErrors: string[] = [];

  for (const gate of gates) {
    const data = dataMap[gate.gateId];
    const resolvedSchema = gate.schemaId ? schemaMap?.get(gate.schemaId) ?? null : null;
    const result = validateGate(gate, data, resolvedSchema);

    if (!result.valid) {
      allErrors.push(...result.errors);
    }
  }

  if (allErrors.length > 0) {
    return { valid: false, errors: allErrors };
  }

  return { valid: true, errors: [] };
}
