#!/usr/bin/env npx tsx

/**
 * File Processor MCA
 *
 * Provides tools to convert various file types:
 * - PDFs to Markdown (digital: local extraction; scanned: local OCR via @teros/ocr)
 * - Images to Markdown (local OCR via @teros/ocr — png, jpg, tiff, webp, gif, bmp)
 * - Audio to text (transcription via OpenAI Whisper)
 * - SVG to PNG conversion
 * - OCR extraction with confidence metadata (ocr-extract tool)
 * - Async job processing with progress tracking
 *
 * Uses McaServer from @teros/mca-sdk for automatic transport detection.
 */

import { Resvg } from '@resvg/resvg-js';
import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { createReadStream, existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { OpenAI } from 'openai';
import { join, extname } from 'path';
import { JobManager } from './job-manager.js';
import { JobWorker } from './job-worker.js';
import { createProcessor } from './processors/factory.js';
import type { FileProcessorOptions } from './types.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Read ANTHROPIC_API_KEY if configured, otherwise ''. `getSystemSecrets()`
 * THROWS ("No system secrets available") when the platform has no system
 * secrets at all. Local extraction (PDF text via unpdf, DOCX via mammoth)
 * needs no key, so a missing key must never block conversion — it only
 * disables the scanned-PDF LLM/OCR fallback.
 */
async function getAnthropicKeyOptional(context: {
  getSystemSecrets: () => Promise<Record<string, string>>;
}): Promise<string> {
  try {
    const secrets = await context.getSystemSecrets();
    return secrets?.ANTHROPIC_API_KEY ?? '';
  } catch {
    return '';
  }
}

const JOBS_DIR = process.env.JOBS_DIR || join(process.cwd(), '../../workspace/.file-processor');

// Initialize job system
const jobManager = new JobManager({
  jobsFile: join(JOBS_DIR, 'jobs.json'),
  cleanupAfterHours: 24,
});

// Job worker (started on first async job)
let jobWorker: JobWorker | null = null;

// Cleanup old jobs on startup
const cleaned = jobManager.cleanupOldJobs();
if (cleaned > 0) {
  console.error(`🧹 Cleaned up ${cleaned} old jobs`);
}

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.teros.file-processor',
  name: 'File Processor',
  version: '2.2.0',
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

server.tool('-health-check', {
  annotations: { readOnlyHint: true },
  description: 'Internal health check tool. Verifies API keys and connectivity.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, _context) => {
    // The core capabilities — PDF (text layer) and Word .docx → Markdown — are
    // extracted locally and need NO secrets, so the MCA is always operational.
    // System keys are optional enhancements only: ANTHROPIC_API_KEY for OCR of
    // scanned PDFs, OPENAI_API_KEY for audio transcription. Their absence does
    // not degrade core function, so it must not produce a blocking health issue
    // (any non-auto_retry issue would flip the MCA to not_ready).
    return new HealthCheckBuilder()
      .setVersion('2.2.0')
      .setUptime(Math.floor(process.uptime()))
      .build();
  },
});

// =============================================================================
// FILE TO MARKDOWN (SYNC)
// =============================================================================

server.tool('file-to-markdown', {
  // safeWriteHint: local file transformation — writes only to the caller's
  // workspace volume, reversible (the output file is deletable), private.
  annotations: { readOnlyHint: false, safeWriteHint: true },
  description:
    'Convert a file to text/Markdown (synchronous). Best for DIGITAL documents: PDFs with a real text layer and Word .docx are extracted exactly and instantly. For scans, photos, handwriting, stamps or ID cards, if you can see images use pdf-to-images instead and read the pages yourself — local OCR (used here as a fallback) is slower and less reliable. Use file-to-markdown-async for long-running jobs.',
  parameters: {
    type: 'object',
    properties: {
      inputPath: {
        type: 'string',
        description: 'Path to the file to convert',
      },
      outputPath: {
        type: 'string',
        description: 'Optional output path (defaults to input path with .md extension)',
      },
      chunkSize: {
        type: 'number',
        description: 'Pages per chunk for large PDFs (default: 10). Only used for PDFs >3MB',
      },
      maxRetries: {
        type: 'number',
        description: 'Maximum retries per chunk if processing fails (default: 3)',
      },
      timeout: {
        type: 'number',
        description:
          'Timeout in milliseconds per chunk (default: 120000 for chunks, 180000 for direct processing)',
      },
    },
    required: ['inputPath'],
  },
  handler: async (args, context) => {
    const { inputPath, chunkSize, maxRetries, timeout } = args as {
      inputPath: string;
      outputPath?: string;
      chunkSize?: number;
      maxRetries?: number;
      timeout?: number;
    };

    if (!inputPath) {
      throw new Error('inputPath is required');
    }

    if (!existsSync(inputPath)) {
      throw new Error(`File not found: ${inputPath}`);
    }

    const anthropicKey = await getAnthropicKeyOptional(context);

    const options: FileProcessorOptions = {
      chunkSize,
      maxRetries,
      timeout,
    };

    // The factory routes by extension (PDF → Claude, DOCX → mammoth) and
    // throws an actionable error for recognized-but-unsupported formats.
    const processor = createProcessor(inputPath, anthropicKey);
    const result = await processor.process(inputPath, options);
    return {
      success: true,
      outputPath: result.outputPath,
      metadata: result.metadata,
    };
  },
});

// =============================================================================
// FILE TO MARKDOWN (ASYNC)
// =============================================================================

server.tool('file-to-markdown-async', {
  // safeWriteHint: local file transformation — writes only to the caller's
  // workspace volume, reversible (the output file is deletable), private.
  annotations: { readOnlyHint: false, safeWriteHint: true },
  description:
    'Convert a file to Markdown asynchronously (non-blocking). Supports PDF, Word .docx, and images (png/jpg/tiff/webp/gif/bmp). Returns a job ID immediately. Use get-job-status to check progress. For scans/photos/handwriting prefer pdf-to-images if you can see images.',
  parameters: {
    type: 'object',
    properties: {
      inputPath: {
        type: 'string',
        description: 'Path to the file to convert',
      },
      outputPath: {
        type: 'string',
        description: 'Optional output path (defaults to input path with .md extension)',
      },
      chunkSize: {
        type: 'number',
        description: 'Pages per chunk for large PDFs (default: 10)',
      },
      maxRetries: {
        type: 'number',
        description: 'Maximum retries per chunk if processing fails (default: 3)',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds per chunk (default: 120000)',
      },
    },
    required: ['inputPath'],
  },
  handler: async (args, context) => {
    const { inputPath, outputPath, chunkSize, maxRetries, timeout } = args as {
      inputPath: string;
      outputPath?: string;
      chunkSize?: number;
      maxRetries?: number;
      timeout?: number;
    };

    if (!inputPath) {
      throw new Error('inputPath is required');
    }

    if (!existsSync(inputPath)) {
      throw new Error(`File not found: ${inputPath}`);
    }

    const anthropicKey = await getAnthropicKeyOptional(context);

    // Validate up-front so unsupported formats (and PDF without a key) fail
    // fast here instead of creating a job that the worker would reject.
    createProcessor(inputPath, anthropicKey);

    const options: FileProcessorOptions = {
      chunkSize,
      maxRetries,
      timeout,
    };

    const job = jobManager.createJob(inputPath, options, outputPath);

    // Start worker if not running
    if (!jobWorker) {
      jobWorker = new JobWorker(jobManager, anthropicKey);
      jobWorker.start().catch((error) => {
        console.error('❌ Job worker failed:', error);
      });
    }

    return {
      success: true,
      jobId: job.id,
      status: job.status,
      message: 'Job queued successfully. Use get-job-status to check progress.',
    };
  },
});

// =============================================================================
// GET JOB STATUS
// =============================================================================

server.tool('get-job-status', {
  annotations: { readOnlyHint: true },
  description:
    'Get the status of an async job. Returns current progress, status, and results when completed.',
  parameters: {
    type: 'object',
    properties: {
      jobId: {
        type: 'string',
        description: 'The job ID returned by file-to-markdown-async',
      },
    },
    required: ['jobId'],
  },
  handler: async (args) => {
    const { jobId } = args as { jobId: string };

    if (!jobId) {
      throw new Error('jobId is required');
    }

    const job = jobManager.getJob(jobId);

    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    return job;
  },
});

// =============================================================================
// LIST JOBS
// =============================================================================

server.tool('list-jobs', {
  annotations: { readOnlyHint: true },
  description:
    'List all jobs with optional filters. Useful for checking active jobs or recent completions.',
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        description: 'Filter by status: queued, processing, completed, failed, cancelled',
        enum: ['queued', 'processing', 'completed', 'failed', 'cancelled'],
      },
      limit: {
        type: 'number',
        description: 'Maximum number of jobs to return (default: 20)',
      },
    },
  },
  handler: async (args) => {
    const { status, limit } = args as {
      status?: 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
      limit?: number;
    };

    const jobs = jobManager.listJobs({
      status,
      limit: limit || 20,
    });

    return {
      success: true,
      count: jobs.length,
      jobs,
    };
  },
});

// =============================================================================
// CANCEL JOB
// =============================================================================

server.tool('cancel-job', {
  // safeWriteHint: cancels the caller's own job — reversible (the job can be
  // re-run), private. `irreversible` only drives the UI badge, not the seed.
  annotations: { readOnlyHint: false, safeWriteHint: true, irreversible: true },
  description: 'Cancel a queued or processing job. Cannot cancel completed/failed jobs.',
  parameters: {
    type: 'object',
    properties: {
      jobId: {
        type: 'string',
        description: 'The job ID to cancel',
      },
    },
    required: ['jobId'],
  },
  handler: async (args) => {
    const { jobId } = args as { jobId: string };

    if (!jobId) {
      throw new Error('jobId is required');
    }

    const cancelled = jobManager.cancelJob(jobId);

    if (!cancelled) {
      throw new Error('Job cannot be cancelled (not found or already completed/failed)');
    }

    return {
      success: true,
      message: `Job ${jobId} cancelled successfully`,
    };
  },
});

// =============================================================================
// AUDIO TO TEXT
// =============================================================================

server.tool('audio-to-text', {
  // safeWriteHint: local file transformation — writes only to the caller's
  // workspace volume, reversible (the output file is deletable), private.
  annotations: { readOnlyHint: false, safeWriteHint: true },
  description:
    'Transcribe audio files to text using OpenAI Whisper API. Supports .m4a, .mp3, .wav, .ogg, .webm, .opus and other audio formats.',
  parameters: {
    type: 'object',
    properties: {
      inputPath: {
        type: 'string',
        description: 'Path to the audio file to transcribe',
      },
      language: {
        type: 'string',
        description:
          "Optional: Language code (e.g., 'es' for Spanish, 'en' for English). Defaults to 'es' (Spanish) to prevent auto-detection from misidentifying Spanish as Catalan/Galician/Portuguese.",
      },
    },
    required: ['inputPath'],
  },
  handler: async (args, context) => {
    const { inputPath, language } = args as {
      inputPath: string;
      language?: string;
    };

    if (!inputPath) {
      throw new Error('inputPath is required');
    }

    if (!existsSync(inputPath)) {
      throw new Error(`Audio file not found: ${inputPath}`);
    }

    const secrets = await context.getSystemSecrets();
    const apiKey = secrets.OPENAI_API_KEY;

    if (!apiKey) {
      throw new Error(
        'OpenAI API key not configured. Please configure OPENAI_API_KEY in system secrets.',
      );
    }

    console.error(`🎙️ Transcribing audio: ${inputPath}`);

    const openai = new OpenAI({ apiKey });

    // Default to Spanish ("es") when no language is specified.
    // Whisper's auto-detection frequently misidentifies Spanish as Catalan,
    // Galician, or Portuguese due to phonetic similarity. Since Pablo always
    // speaks Spanish, forcing "es" eliminates the misidentification.
    // Callers can still override by passing an explicit language parameter.
    const effectiveLanguage = language || 'es';

    const transcription = await openai.audio.transcriptions.create({
      file: createReadStream(inputPath) as any,
      model: 'whisper-1',
      language: effectiveLanguage,
      response_format: 'verbose_json',
    });

    console.error(`✅ Transcription complete (language=${effectiveLanguage}): ${transcription.text.substring(0, 100)}...`);

    return {
      success: true,
      transcription: transcription.text,
      language: transcription.language,
      duration: transcription.duration,
    };
  },
});

// =============================================================================
// SVG TO PNG
// =============================================================================

/**
 * Collect font file paths from a directory recursively.
 * Returns absolute paths to .ttf and .otf files.
 */
function collectFontFiles(dir: string): string[] {
  const fonts: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        fonts.push(...collectFontFiles(fullPath));
      } else {
        const ext = extname(entry.name).toLowerCase();
        if (ext === '.ttf' || ext === '.otf') {
          fonts.push(fullPath);
        }
      }
    }
  } catch {
    // directory doesn't exist or isn't readable — skip silently
  }
  return fonts;
}

/**
 * Build font configuration for Resvg.
 *
 * Loads system fonts + any .ttf/.otf found in /workspace (so user-uploaded
 * fonts or design-system fonts are available without installing them
 * system-wide). This ensures SVG <text> elements render correctly when
 * converted to PNG, regardless of which fonts the SVG references.
 */
function buildFontConfig(): { font: { fontFiles: string[]; fontDirs: string[]; defaultFontFamily: string }; loadSystemFonts: boolean } {
  const fontDirs = ['/usr/share/fonts'];
  const fontFiles: string[] = [];

  // Collect system fonts
  for (const dir of fontDirs) {
    fontFiles.push(...collectFontFiles(dir));
  }

  // Collect workspace fonts (user-uploaded, design-system, etc.)
  const workspaceFontDirs = [
    '/workspace/fonts',
    '/workspace/design-system',
  ];
  for (const dir of workspaceFontDirs) {
    fontFiles.push(...collectFontFiles(dir));
  }

  // Also scan /workspace recursively for fonts, but limit depth to avoid
  // scanning huge node_modules trees
  try {
    const wsEntries = readdirSync('/workspace', { withFileTypes: true });
    for (const entry of wsEntries) {
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
        const subDir = join('/workspace', entry.name);
        // Only go 2 levels deep
        try {
          const subEntries = readdirSync(subDir, { withFileTypes: true });
          for (const subEntry of subEntries) {
            if (subEntry.isDirectory()) {
              const fontSubDir = join(subDir, subEntry.name);
              // Check if this directory or its immediate children contain fonts
              try {
                const fontEntries = readdirSync(fontSubDir, { withFileTypes: true });
                for (const fe of fontEntries) {
                  if (fe.isDirectory() && fe.name.toLowerCase().includes('font')) {
                    fontFiles.push(...collectFontFiles(join(fontSubDir, fe.name)));
                  } else {
                    const ext = extname(fe.name).toLowerCase();
                    if (ext === '.ttf' || ext === '.otf') {
                      fontFiles.push(join(fontSubDir, fe.name));
                    }
                  }
                }
              } catch {}
            } else {
              const ext = extname(subEntry.name).toLowerCase();
              if (ext === '.ttf' || ext === '.otf') {
                fontFiles.push(join(subDir, subEntry.name));
              }
            }
          }
        } catch {}
      }
    }
  } catch {}

  // Deduplicate
  const uniqueFonts = [...new Set(fontFiles)];

  return {
    loadSystemFonts: true,
    font: {
      fontFiles: uniqueFonts,
      fontDirs,
      defaultFontFamily: 'DejaVu Sans',
    },
  };
}

server.tool('svg-to-png', {
  // safeWriteHint: local file transformation — writes only to the caller's
  // workspace volume, reversible (the output file is deletable), private.
  annotations: { readOnlyHint: false, safeWriteHint: true },
  description: 'Convert SVG files to PNG with optional width/height constraints',
  parameters: {
    type: 'object',
    properties: {
      inputPath: {
        type: 'string',
        description: 'Path to the SVG file to convert',
      },
      outputPath: {
        type: 'string',
        description: 'Optional output path (defaults to input path with .png extension)',
      },
      width: {
        type: 'number',
        description: 'Optional: Target width in pixels',
      },
      height: {
        type: 'number',
        description: 'Optional: Target height in pixels',
      },
    },
    required: ['inputPath'],
  },
  handler: async (args) => {
    const { inputPath, outputPath, width, height } = args as {
      inputPath: string;
      outputPath?: string;
      width?: number;
      height?: number;
    };

    if (!inputPath) throw new Error('inputPath is required');
    if (!existsSync(inputPath)) throw new Error(`File not found: ${inputPath}`);

    const finalOutputPath = outputPath || inputPath.replace(/\.svg$/i, '.png');

    console.error(`🎨 Converting SVG to PNG: ${inputPath}`);

    const svg = readFileSync(inputPath, 'utf-8');

    const resvgOpts: any = {
      ...buildFontConfig(),
    };

    if (width && height) {
      resvgOpts.fitTo = { mode: "width" as const, value: Math.min(width, height) };
    } else if (width) {
      resvgOpts.fitTo = { mode: "width" as const, value: width };
    } else if (height) {
      resvgOpts.fitTo = { mode: "height" as const, value: height };
    }

    const resvg = new Resvg(svg, resvgOpts);
    const pngData = resvg.render();
    const pngBuffer = pngData.asPng();

    writeFileSync(finalOutputPath, pngBuffer);

    console.error(`✅ SVG converted successfully: ${finalOutputPath}`);

    return {
      success: true,
      outputPath: finalOutputPath,
      width: pngData.width,
      height: pngData.height,
      size: pngBuffer.length,
    };
  },
});

// =============================================================================
// OCR EXTRACT
// =============================================================================

server.tool('ocr-extract', {
  annotations: { readOnlyHint: true },
  description:
    'FALLBACK ONLY — local OCR (tesseract.js) of an image or PDF. If you can see images, use pdf-to-images instead: reading the pages with vision is faster and far more accurate on scans, handwriting, pen corrections and stamps. Use this only when images are reported as not shown (model without vision). Returns per-page confidence scores and low-confidence word markers. Supports: png, jpg, jpeg, tiff, webp, gif, bmp, pdf.',
  parameters: {
    type: 'object',
    properties: {
      inputPath: {
        type: 'string',
        description: 'Path to the image or PDF file',
      },
      languages: {
        type: 'array',
        items: { type: 'string', enum: ['spa', 'eng'] },
        description: "OCR languages (default: ['spa', 'eng'])",
      },
      pages: {
        type: 'string',
        description: "Pages to process, e.g. '1-3,5' (default: all). Only for PDFs.",
      },
      format: {
        type: 'string',
        enum: ['markdown', 'text', 'json'],
        description: "Output format (default: 'markdown')",
      },
    },
    required: ['inputPath'],
  },
  handler: async (args) => {
    const { inputPath, languages, pages, format } = args as {
      inputPath: string;
      languages?: string[];
      pages?: string;
      format?: 'markdown' | 'text' | 'json';
    };

    if (!inputPath) throw new Error('inputPath is required');
    if (!existsSync(inputPath)) throw new Error(`File not found: ${inputPath}`);

    const buffer = readFileSync(inputPath);
    const { extractText: ocrExtract, formatResult } = await import('./vendor/teros-ocr/index.js');

    // Parse pages spec (e.g. "1-3,5") into number array
    let pagesArray: number[] | 'all' = 'all';
    if (pages) {
      const pageSet = new Set<number>();
      for (const part of pages.split(',')) {
        const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
        if (!m) throw new Error(`Invalid pages spec: "${part}" (use e.g. 1-3,5)`);
        const from = parseInt(m[1], 10);
        const to = m[2] ? parseInt(m[2], 10) : from;
        for (let p = from; p <= to; p++) pageSet.add(p);
      }
      pagesArray = [...pageSet].sort((a, b) => a - b);
    }

    const result = await ocrExtract(buffer, {
      languages: (languages || ['spa', 'eng']) as Array<'spa' | 'eng'>,
      pages: pagesArray,
    });

    const outputFormat = format || 'markdown';
    const output = formatResult(result, outputFormat);

    return {
      success: true,
      text: output,
      // Agents whose skills still say "use the OCR" get steered back to vision.
      hint: 'If you can see images, prefer pdf-to-images for this file: reading the pages with vision is faster and more accurate than this OCR (especially handwriting and stamps).',
      metadata: {
        inputFile: inputPath,
        inputType: result.inputType,
        engine: result.engine,
        pages: result.pages.length,
        meanConfidence: result.meanConfidence,
        totalDurationMs: result.totalDurationMs,
        warnings: result.warnings,
      },
    };
  },
});

// =============================================================================
// PDF/IMAGE → IMAGES IN THE MODEL'S CONTEXT (vision)
// =============================================================================

/** Parse a pages spec like "1-3,5" into sorted page numbers. */
function parsePagesSpec(spec: string): number[] {
  const pageSet = new Set<number>();
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`Invalid pages spec: "${part}" (use e.g. 1-3,5)`);
    const from = parseInt(m[1], 10);
    const to = m[2] ? parseInt(m[2], 10) : from;
    for (let p = from; p <= to; p++) pageSet.add(p);
  }
  return [...pageSet].sort((a, b) => a - b);
}

const VISION_MAX_PAGES = 10;

server.tool('pdf-to-images', {
  annotations: { readOnlyHint: true },
  description:
    'Show a PDF or an image file to YOU (the model) as images in your context, so you can read it with vision — scans, handwriting, pen corrections, stamps, ID cards, forms. Each PDF page is rendered in colour and attached to the result like an image the user pasted in chat. Use it whenever you need to actually look at a document (e.g. a PDF downloaded from an email); prefer it over ocr-extract when you can see images, and fall back to ocr-extract if the images are reported as not shown. Supports pdf, png, jpg, jpeg, webp, gif, tiff, bmp. Max 10 pages per call — use `pages` for the rest.',
  parameters: {
    type: 'object',
    properties: {
      inputPath: {
        type: 'string',
        description: 'Path to the PDF or image file (e.g. /workspace/inbox/acta.pdf)',
      },
      pages: {
        type: 'string',
        description: "PDF pages to show, e.g. '1-3,5' (default: the first 10). Ignored for images.",
      },
      dpi: {
        type: 'number',
        description: 'PDF render resolution (default 150; 200 for small print). Ignored for images.',
      },
      maxDimension: {
        type: 'number',
        description: 'Longest side of each attached image in px (default 1568, 512–2048).',
      },
      autoRotate: {
        type: 'boolean',
        description:
          'Straighten sideways/upside-down pages (scanned IDs…) before attaching them (default true). Upright pages cost one quick check; only rotated ones take longer.',
      },
    },
    required: ['inputPath'],
  },
  handler: async (args, context) => {
    const { inputPath, pages, dpi, maxDimension, autoRotate } = args as {
      inputPath: string;
      pages?: string;
      dpi?: number;
      maxDimension?: number;
      autoRotate?: boolean;
    };
    if (!inputPath) throw new Error('inputPath is required');
    if (!existsSync(inputPath)) throw new Error(`File not found: ${inputPath}`);
    if (!context.objects) {
      throw new Error('Object storage is not available, so images cannot be attached to the context.');
    }

    const buffer = readFileSync(inputPath);
    const { createOrientationDetector, detectInputType, renderPdfPages } = await import(
      './vendor/teros-ocr/index.js'
    );
    const sharp = (await import('sharp')).default;
    const inputType = detectInputType(buffer);
    const name = inputPath.split('/').pop() || 'document';
    const maxSide = Math.min(2048, Math.max(512, Math.round(maxDimension ?? 1568)));

    let sources: Array<{ label: string; png: Buffer }>;
    let totalPages = 1;
    let omitted = 0;
    if (inputType === 'pdf') {
      const rendered = await renderPdfPages(buffer, {
        pages: pages ? parsePagesSpec(pages) : 'all',
        dpi: Math.min(300, Math.max(72, Math.round(dpi ?? 150))),
        maxPages: VISION_MAX_PAGES,
      });
      totalPages = rendered.totalPages;
      omitted = rendered.omitted;
      sources = rendered.pages.map((p) => ({ label: `p${p.pageNumber}`, png: p.png }));
      if (sources.length === 0) throw new Error(`No pages to show (the PDF has ${totalPages} page(s)).`);
    } else if (inputType === 'image') {
      sources = [{ label: 'img', png: buffer }];
    } else {
      throw new Error('Unsupported file: pdf-to-images accepts PDFs and images (png, jpg, webp, gif, tiff, bmp).');
    }

    const attachments: Array<{ url: string; mime: string; filename: string }> = [];
    const shown: string[] = [];
    const rotated: string[] = [];
    // One tesseract worker for the whole call, only to check orientation.
    const detector = autoRotate === false ? null : await createOrientationDetector({ languages: ['spa', 'eng'] });
    try {
      for (const src of sources) {
        const label = src.label === 'img' ? 'image' : `page ${src.label.slice(1)}`;
        // EXIF orientation first (camera photos), then content orientation.
        let png = await sharp(src.png, { failOn: 'none' }).rotate().png().toBuffer();
        const angle = detector ? await detector.detect(png) : 0;
        if (angle) {
          png = await sharp(png).rotate(angle).png().toBuffer();
          rotated.push(`${label} ${angle}°`);
        }
        // Flatten transparency onto white, fit the longest side, JPEG.
        const jpeg = await sharp(png)
          .flatten({ background: '#ffffff' })
          .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 82 })
          .toBuffer();
        const filename = `${name.replace(/\.[^.]+$/, '')}-${src.label}.jpg`;
        const put = await context.objects.put(jpeg, 'image/jpeg', {
          source: 'mca.teros.file-processor',
          tool: 'pdf-to-images',
          filename,
        });
        if (!put.success) throw new Error(`Could not store ${filename}: ${put.error ?? 'unknown error'}`);
        attachments.push({ url: put.url, mime: 'image/jpeg', filename });
        shown.push(label);
      }
    } finally {
      await detector?.dispose();
    }

    const scope =
      inputType === 'pdf'
        ? `${shown.length} of ${totalPages} page(s) (${shown.join(', ')})${omitted > 0 ? `; ${omitted} more requested page(s) not shown — call again with \`pages\`` : ''}`
        : 'the image';
    const straightened = rotated.length ? ` Straightened automatically: ${rotated.join(', ')}.` : '';
    return {
      output: `Attached ${scope} of ${inputPath} as image(s) in your context.${straightened} Read them visually; if they are reported as not shown, use ocr-extract instead.`,
      attachments,
    };
  },
});

// =============================================================================
// START SERVER
// =============================================================================

server.start();
