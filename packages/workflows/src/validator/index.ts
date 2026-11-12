/**
 * Validator — Public API
 *
 * Re-exports the gate validation functions and types.
 *
 * In the Flowing model, gates reference Artifacts via schemaId. Validation is
 * done against the artifact's schema (ArtifactSchema), not text templates or
 * inline JSON Schemas. Text template validation is kept only for instruction
 * interpolation (not gate validation).
 *
 * Usage:
 *   import {
 *     validateGate,
 *     validateGates,
 *     validateArtifactSchema,
 *     artifactSchemaToZod,
 *     validateJsonSchema,
 *     jsonSchemaToZod,
 *     validateTextTemplate,
 *     extractTemplateVariables,
 *     type ValidationResult,
 *   } from '@teros/workflows/validator';
 */

// Types
export type { ValidationResult } from './types';

// Re-export form-first types from models (unified with User Forms)
export type { FieldType, FieldOption } from '../models/types';

// Gate-level validation (artifact schema-based — Flowing model)
export { validateGate, validateGates } from './gate-validator';

// Artifact Schema validation (Flowing model)
export { validateArtifactSchema, artifactSchemaToZod } from './json-validator';

// JSON Schema validation (legacy / advanced)
export { validateJsonSchema, jsonSchemaToZod } from './json-validator';

// Text template validation (for instruction interpolation only — NOT gate validation)
export { validateTextTemplate, extractTemplateVariables } from './text-validator';
