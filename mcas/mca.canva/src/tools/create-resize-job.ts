import type { ToolConfig } from '@teros/mca-sdk';
import { buildResizeJobShape, canvaRequest } from '../lib';
import { JOB_FIELDS } from './_fields';
import { validateNonEmpty } from './_validate';
import { resolveFields } from './utils';

const PRESET_NAMES = ['doc', 'whiteboard', 'presentation', 'email'] as const;

export const createResizeJob: ToolConfig = {
  description:
    'Resize a design to a new size (preset or custom). Async — returns curated job (poll get-resize-job). Use designType="custom" with width+height OR a preset name. Output is a NEW design at top level. Not retryable. Params: designId, designType, width?, height?, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      designId: { type: 'string', description: 'Source Canva design ID.' },
      designType: {
        type: 'string',
        enum: ['doc', 'whiteboard', 'presentation', 'email', 'custom'],
        description: 'Preset name or "custom" with width+height.',
      },
      width: { type: 'number', description: 'New width in pixels (custom only).' },
      height: { type: 'number', description: 'New height in pixels (custom only).' },
      fields: { type: 'array', items: { type: 'string' }, description: 'Override default whitelist.' },
      includeRaw: { type: 'boolean', description: 'Return raw Canva job response. Default false.' },
    },
    required: ['designId', 'designType'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'experimental' },
  handler: async (args, context) => {
    const { designId, designType, width, height, fields, includeRaw } = args as {
      designId: string;
      designType: string;
      width?: number;
      height?: number;
      fields?: string[];
      includeRaw?: boolean;
    };
    validateNonEmpty(designId, 'designId');
    validateNonEmpty(designType, 'designType');

    let designTypeBody: Record<string, unknown>;
    if (designType === 'custom') {
      if (typeof width !== 'number' || typeof height !== 'number') {
        throw new Error('When designType="custom", width and height are required.');
      }
      designTypeBody = { type: 'custom', width, height };
    } else {
      if (!PRESET_NAMES.includes(designType as (typeof PRESET_NAMES)[number])) {
        throw new Error(
          `designType must be one of: ${PRESET_NAMES.join(', ')}, custom (received: ${designType}).`,
        );
      }
      designTypeBody = { type: 'preset', name: designType };
    }

    const raw = await canvaRequest(context, '/resizes', {
      method: 'POST',
      body: { design_id: designId, design_type: designTypeBody },
    });
    const shape = buildResizeJobShape(raw);
    return resolveFields(shape as any, raw, { includeRaw, fields, defaultFields: JOB_FIELDS });
  },
};
