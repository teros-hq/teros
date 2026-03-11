/**
 * Job Manager for asynchronous file processing
 * Handles job queue, persistence, and background execution
 */

import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { FileProcessorOptions, ProcessorResult } from './types.js';

export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  type: 'file_to_markdown';
  status: JobStatus;
  inputPath: string;
  outputPath?: string;
  options?: FileProcessorOptions;

  // Progress tracking
  progress?: {
    current: number;
    total: number;
    message: string;
  };

  // Timing
  createdAt: string;
  startedAt?: string;
  completedAt?: string;

  // Results
  result?: ProcessorResult;
  error?: string;
}

export interface JobManagerConfig {
  jobsFile: string;
  cleanupAfterHours?: number; // Clean completed jobs older than X hours (default: 24)
}

export class JobManager {
  private config: JobManagerConfig;
  private jobs: Map<string, Job> = new Map();

  constructor(config: JobManagerConfig) {
    this.config = {
      ...config,
      cleanupAfterHours: config.cleanupAfterHours || 24,
    };

    // Ensure directory exists
    const dir = dirname(this.config.jobsFile);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Load existing jobs
    this.loadJobs();
  }

  /**
   * Create a new job
   */
  createJob(inputPath: string, options?: FileProcessorOptions, outputPath?: string): Job {
    const job: Job = {
      id: randomUUID(),
      type: 'file_to_markdown',
      status: 'queued',
      inputPath,
      outputPath,
      options,
      createdAt: new Date().toISOString(),
    };

    this.jobs.set(job.id, job);
    this.saveJobs();

    return job;
  }

  /**
   * Get job by ID
   */
  getJob(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /**
   * List all jobs with optional filters
   */
  listJobs(filters?: { status?: JobStatus; limit?: number }): Job[] {
    let jobs = Array.from(this.jobs.values());

    // Filter by status
    if (filters?.status) {
      jobs = jobs.filter((job) => job.status === filters.status);
    }

    // Sort by created date (newest first)
    jobs.sort((a, b) => {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    // Limit results
    if (filters?.limit) {
      jobs = jobs.slice(0, filters.limit);
    }

    return jobs;
  }

  /**
   * Update job status
   */
  updateJobStatus(id: string, status: JobStatus, error?: string): void {
    const job = this.jobs.get(id);
    if (!job) return;

    job.status = status;

    if (status === 'processing' && !job.startedAt) {
      job.startedAt = new Date().toISOString();
    }

    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      job.completedAt = new Date().toISOString();
    }

    if (error) {
      job.error = error;
    }

    this.jobs.set(id, job);
    this.saveJobs();
  }

  /**
   * Update job progress
   */
  updateJobProgress(id: string, current: number, total: number, message: string): void {
    const job = this.jobs.get(id);
    if (!job) return;

    job.progress = { current, total, message };
    this.jobs.set(id, job);
    this.saveJobs();
  }

  /**
   * Complete job with result
   */
  completeJob(id: string, result: ProcessorResult): void {
    const job = this.jobs.get(id);
    if (!job) return;

    job.status = 'completed';
    job.result = result;
    job.completedAt = new Date().toISOString();

    this.jobs.set(id, job);
    this.saveJobs();
  }

  /**
   * Cancel a job
   */
  cancelJob(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;

    // Can only cancel queued or processing jobs
    if (job.status !== 'queued' && job.status !== 'processing') {
      return false;
    }

    job.status = 'cancelled';
    job.completedAt = new Date().toISOString();

    this.jobs.set(id, job);
    this.saveJobs();

    return true;
  }

  /**
   * Clean up old completed jobs
   */
  cleanupOldJobs(): number {
    const now = Date.now();
    const maxAge = this.config.cleanupAfterHours! * 60 * 60 * 1000;
    let cleaned = 0;

    for (const [id, job] of this.jobs.entries()) {
      if (
        (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') &&
        job.completedAt
      ) {
        const completedTime = new Date(job.completedAt).getTime();
        if (now - completedTime > maxAge) {
          this.jobs.delete(id);
          cleaned++;
        }
      }
    }

    if (cleaned > 0) {
      this.saveJobs();
    }

    return cleaned;
  }

  /**
   * Load jobs from disk
   */
  private loadJobs(): void {
    if (!existsSync(this.config.jobsFile)) {
      return;
    }

    try {
      const data = readFileSync(this.config.jobsFile, 'utf-8');
      const jobsArray = JSON.parse(data) as Job[];

      this.jobs.clear();
      for (const job of jobsArray) {
        this.jobs.set(job.id, job);
      }

      console.error(`📂 Loaded ${this.jobs.size} jobs from disk`);
    } catch (error) {
      console.error('⚠️  Failed to load jobs:', error);
    }
  }

  /**
   * Save jobs to disk
   */
  private saveJobs(): void {
    try {
      const jobsArray = Array.from(this.jobs.values());
      const data = JSON.stringify(jobsArray, null, 2);
      writeFileSync(this.config.jobsFile, data, 'utf-8');
    } catch (error) {
      console.error('⚠️  Failed to save jobs:', error);
    }
  }
}
