import type { ToolConfig } from '@teros/mca-sdk';
import { buildExportJobShape, canvaRequest } from '../lib';
import { JOB_FIELDS } from './_fields';
import { validateNonEmpty, validatePages } from './_validate';
import { resolveFields, sanitiseBody } from './utils';

const FORMAT_TYPES = ['pdf', 'png', 'jpg', 'gif', 'pptx', 'mp4', 'html_bundle', 'html_standalone'] as const;
type FormatType = (typeof FORMAT_TYPES)[number];

export const exportDesign: ToolConfig = {
  description:
    'Start an export job for a design. Returns curated job (poll get-export-job by id). Formats: pdf, png, jpg, gif, pptx, mp4, html_bundle, html_standalone. transparentBackground only for png. Not retryable. Params: designId, format, quality?, width?, height?, pages?, transparentBackground?, fields?, includeRaw.',
  parameters: {
    type: 'object',
    properties: {
      designId: { type: 'string', description: 'Canva design ID.' },
      format: { type: 'string', enum: [...FORMAT_TYPES] },
      quality: { type: 'number', description: 'JPEG quality 1-100 (jpg only).' },
      width: { type: 'number', description: 'Export width in pixels (png/jpg).' },
      height: { type: 'number', description: 'Export height in pixels (png/jpg).' },
      pages: {
        type: 'array',
        items: { type: 'number' },
        description: 'Pages to export (1-indexed).',
      },
      transparentBackground: {
        type: 'boolean',
        description: 'PNG only — keep canvas transparent. Default false.',
      },
      fields: { type: 'array', items: { type: 'string' }, description: 'Override default whitelist.' },
      includeRaw: { type: 'boolean', description: 'Return raw Canva job response. Default false.' },
    },
    required: ['designId', 'format'],
  },
  annotations: { readOnlyHint: false, version: '1.0.0', stability: 'stable' },
  handler: async (args, context) => {
    const { designId, format, quality, width, height, pages, transparentBackground, fields, includeRaw } =
      args as {
        designId: string;
        format: FormatType;
        quality?: number;
        width?: number;
        height?: number;
        pages?: number[];
        transparentBackground?: boolean;
        fields?: string[];
        includeRaw?: boolean;
      };
    validateNonEmpty(designId, 'designId');
    if (!FORMAT_TYPES.includes(format)) {
      throw new Error(`format must be one of: ${FORMAT_TYPES.join(', ')} (received: ${format}).`);
    }
    if (pages !== undefined) validatePages(pages, 'pages');
    if (transparentBackground && format !== 'png') {
      throw new Error('transparentBackground is only supported when format is "png".');
    }
    // Canva exige quality (1-100) para video formats; sin él el endpoint
    // responde con un mensaje genérico "'quality' must not be null".
    // Validamos al boundary para que el LLM vea el requisito explícito.
    if ((format === 'mp4' || format === 'gif') && (quality == null || quality < 1 || quality > 100)) {
      throw new Error(
        `quality is required for format "${format}" and must be an integer in [1, 100] (received: ${quality}).`,
      );
    }

    const formatBody: Record<string, unknown> = { type: format };
    if ((format === 'jpg' || format === 'mp4' || format === 'gif') && quality)
      formatBody.quality = quality;
    if (width) formatBody.width = width;
    if (height) formatBody.height = height;
    if (pages) formatBody.pages = pages;
    if (transparentBackground) formatBody.transparent_background = true;

    const body = sanitiseBody({ design_id: designId, format: formatBody });
    const raw = await canvaRequest(context, '/exports', { method: 'POST', body });
    const shape = buildExportJobShape(raw);
    return resolveFields(shape as any, raw, { includeRaw, fields, defaultFields: JOB_FIELDS });
  },
};
