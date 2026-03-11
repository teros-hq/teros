#!/usr/bin/env npx tsx

/**
 * File Processor MCA
 *
 * Provides tools to convert various file types:
 * - PDFs to Markdown (with intelligent chunking for large files)
 * - Audio to text (transcription via OpenAI Whisper)
 * - SVG to PNG conversion
 * - Async job processing with progress tracking
 *
 * Uses McaServer from @teros/mca-sdk for automatic transport detection.
 */

import { Resvg } from '@resvg/resvg-js';
import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'fs';
import { OpenAI } from 'openai';
import { join } from 'path';
import { JobManager } from './job-manager.js';
import { JobWorker } from './job-worker.js';
import { detectFileType } from './processors/base.js';
import { PDFProcessor } from './processors/pdf.js';
import type { FileProcessorOptions } from './types.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

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
  description: 'Internal health check tool. Verifies API keys and connectivity.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder().setVersion('2.2.0');

    try {
      const secrets = await context.getSystemSecrets();
      const hasOpenAI = !!secrets.OPENAI_API_KEY;
      const hasAnthropic = !!secrets.ANTHROPIC_API_KEY;

      if (!hasOpenAI) {
        builder.addIssue(
          'CONFIG_MISSING',
          'OpenAI API key not configured (needed for audio transcription)',
          {
            type: 'admin_action',
            description: 'Configure OPENAI_API_KEY in system secrets',
          },
        );
      }

      if (!hasAnthropic) {
        builder.addIssue(
          'CONFIG_MISSING',
          'Anthropic API key not configured (needed for PDF processing)',
          {
            type: 'admin_action',
            description: 'Configure ANTHROPIC_API_KEY in system secrets',
          },
        );
      }

      return builder.build();
    } catch (error: any) {
      builder.addIssue('SECRETS_ERROR', `Failed to get secrets: ${error.message}`, {
        type: 'admin_action',
        description: 'Check backend connectivity and secrets configuration',
      });
      return builder.build();
    }
  },
});

// =============================================================================
// FILE TO MARKDOWN (SYNC)
// =============================================================================

server.tool('file-to-markdown', {
  description:
    'Convert files to Markdown using AI (synchronous). Supports PDF (with intelligent chunking for large files). Use file-to-markdown-async for long-running jobs.',
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

    const secrets = await context.getSystemSecrets();
    const anthropicKey = secrets.ANTHROPIC_API_KEY;

    if (!anthropicKey) {
      throw new Error(
        'Anthropic API key not configured. Please configure ANTHROPIC_API_KEY in system secrets.',
      );
    }

    const processor = new PDFProcessor(anthropicKey);

    const fileType = detectFileType(inputPath);
    if (!fileType) {
      throw new Error(
        `Unsupported file type. Supported: PDF, images (PNG/JPG/GIF/WebP), documents (DOCX/XLSX/PPTX), text (TXT/MD/CSV)`,
      );
    }

    const options: FileProcessorOptions = {
      chunkSize,
      maxRetries,
      timeout,
    };

    if (fileType === 'pdf') {
      const result = await processor.process(inputPath, options);
      return {
        success: true,
        outputPath: result.outputPath,
        metadata: result.metadata,
      };
    } else {
      throw new Error(
        `File type "${fileType}" is not yet implemented. Currently only PDF is supported.`,
      );
    }
  },
});

// =============================================================================
// FILE TO MARKDOWN (ASYNC)
// =============================================================================

server.tool('file-to-markdown-async', {
  description:
    'Convert files to Markdown asynchronously (non-blocking). Returns a job ID immediately. Use get-job-status to check progress.',
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

    const secrets = await context.getSystemSecrets();
    const anthropicKey = secrets.ANTHROPIC_API_KEY;

    if (!anthropicKey) {
      throw new Error(
        'Anthropic API key not configured. Please configure ANTHROPIC_API_KEY in system secrets.',
      );
    }

    const fileType = detectFileType(inputPath);
    if (!fileType) {
      throw new Error(`Unsupported file type. Supported: PDF, images, documents, text`);
    }

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
          "Optional: Language code (e.g., 'es' for Spanish, 'en' for English). Auto-detected if not provided.",
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

    const transcription = await openai.audio.transcriptions.create({
      file: createReadStream(inputPath) as any,
      model: 'whisper-1',
      language: language || undefined,
      response_format: 'verbose_json',
    });

    console.error(`✅ Transcription complete: ${transcription.text.substring(0, 100)}...`);

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

server.tool('svg-to-png', {
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

    const resvgOpts: any = {};

    if (width) {
      resvgOpts.fitTo = { mode: 'width' as const, value: width };
    } else if (height) {
      resvgOpts.fitTo = { mode: 'height' as const, value: height };
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
// START SERVER
// =============================================================================

server.start();
