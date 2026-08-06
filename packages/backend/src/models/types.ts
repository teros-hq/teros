/**
 * Shared types for model definitions.
 * Imported by definitions.ts and all per-provider files in ./providers/.
 */

import type { Model } from '../types/database';

/**
 * Model definition type (without timestamps - those are added by sync)
 */
export type ModelDefinition = Omit<Model, 'createdAt' | 'updatedAt'>;
