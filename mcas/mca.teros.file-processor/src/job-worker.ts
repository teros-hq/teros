/**
 * Job Worker - Executes jobs in background
 */

import type { Job, JobManager } from './job-manager.js';
import { detectFileType } from './processors/base.js';
import { PDFProcessor } from './processors/pdf.js';

export class JobWorker {
  private jobManager: JobManager;
  private isProcessing = false;
  private currentJobId: string | null = null;
  private pdfProcessor: PDFProcessor;
  private anthropicApiKey: string;

  constructor(jobManager: JobManager, anthropicApiKey: string) {
    this.jobManager = jobManager;
    this.anthropicApiKey = anthropicApiKey;
    this.pdfProcessor = new PDFProcessor(anthropicApiKey);
  }

  /**
   * Start processing jobs from the queue
   */
  async start(): Promise<void> {
    if (this.isProcessing) {
      console.error('⚠️  Worker already processing');
      return;
    }

    this.isProcessing = true;
    console.error('🚀 Job worker started');

    // Process jobs continuously
    while (this.isProcessing) {
      try {
        const job = await this.getNextJob();

        if (job) {
          await this.processJob(job);
        } else {
          // No jobs, wait a bit
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch (error) {
        console.error('❌ Worker error:', error);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  /**
   * Stop the worker
   */
  stop(): void {
    this.isProcessing = false;
    console.error('🛑 Job worker stopped');
  }

  /**
   * Get next queued job
   */
  private async getNextJob(): Promise<Job | null> {
    const queuedJobs = this.jobManager.listJobs({ status: 'queued', limit: 1 });
    return queuedJobs.length > 0 ? queuedJobs[0] : null;
  }

  /**
   * Process a single job
   */
  private async processJob(job: Job): Promise<void> {
    this.currentJobId = job.id;

    console.error(`\n📋 Processing job ${job.id}`);
    console.error(`📄 Input: ${job.inputPath}`);

    try {
      // Update status to processing
      this.jobManager.updateJobStatus(job.id, 'processing');

      // Detect file type
      const fileType = detectFileType(job.inputPath);
      if (!fileType) {
        throw new Error('Unsupported file type');
      }

      // Process based on type
      let result;

      if (fileType === 'pdf') {
        // Process with progress tracking
        result = await this.processPDFWithProgress(job);
      } else {
        throw new Error(`File type "${fileType}" not yet implemented`);
      }

      // Mark as completed
      this.jobManager.completeJob(job.id, result);
      console.error(`✅ Job ${job.id} completed`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.jobManager.updateJobStatus(job.id, 'failed', errorMessage);
      console.error(`❌ Job ${job.id} failed:`, errorMessage);
    } finally {
      this.currentJobId = null;
    }
  }

  /**
   * Process PDF with progress updates
   */
  private async processPDFWithProgress(job: Job): Promise<any> {
    // We need to monkey-patch the console.log to capture progress
    const originalConsoleError = console.error;
    const progressRegex = /Processing pages (\d+)-(\d+) of (\d+)/;

    console.error = (...args: any[]) => {
      const message = args.join(' ');

      // Check for progress messages
      const match = message.match(progressRegex);
      if (match) {
        const startPage = parseInt(match[1]);
        const endPage = parseInt(match[2]);
        const totalPages = parseInt(match[3]);

        // Calculate chunk number
        const chunkSize = job.options?.chunkSize || 10;
        const currentChunk = Math.floor(startPage / chunkSize) + 1;
        const totalChunks = Math.ceil(totalPages / chunkSize);

        this.jobManager.updateJobProgress(
          job.id,
          currentChunk,
          totalChunks,
          `Processing pages ${startPage}-${endPage} of ${totalPages}`,
        );
      }

      // Call original
      originalConsoleError(...args);
    };

    try {
      const result = await this.pdfProcessor.process(job.inputPath, job.options);
      return result;
    } finally {
      // Restore console.error
      console.error = originalConsoleError;
    }
  }

  /**
   * Check if worker is currently processing
   */
  isActive(): boolean {
    return this.isProcessing && this.currentJobId !== null;
  }

  /**
   * Get current job ID being processed
   */
  getCurrentJobId(): string | null {
    return this.currentJobId;
  }
}
