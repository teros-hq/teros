import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { JobManager } from '../src/job-manager';

// Production regression (2026-11): tesseract.js downloaded its language data
// from cdn.jsdelivr.net; when that could not finish the worker never started,
// pdf-to-images with autoRotate failed and OCR jobs stayed `processing` forever.

describe('bundled OCR language data (no download at runtime)', () => {
  it('ships spa and eng traineddata where the vendored OCR reads them', () => {
    const dir = join(import.meta.dir, '..', 'tessdata');
    for (const lang of ['spa', 'eng']) {
      const file = join(dir, `${lang}.traineddata.gz`);
      expect(existsSync(file)).toBe(true);
      // A real gzip of a real model, not an LFS pointer or a truncated download.
      expect(gunzipSync(readFileSync(file)).length).toBeGreaterThan(1_000_000);
    }
  });
});

describe('JobManager.failInterruptedJobs (no job stays processing forever)', () => {
  it('fails jobs a previous run left processing and leaves the rest alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-jobs-'));
    try {
      const jobsFile = join(dir, 'jobs.json');
      const before = new JobManager({ jobsFile });
      const stuck = before.createJob('/workspace/scan.pdf');
      before.updateJobStatus(stuck.id, 'processing');
      const queued = before.createJob('/workspace/next.pdf');
      const done = before.createJob('/workspace/done.pdf');
      before.updateJobStatus(done.id, 'completed');

      // A new process starts on the same jobs file.
      const after = new JobManager({ jobsFile });
      expect(after.failInterruptedJobs()).toBe(1);

      const job = after.getJob(stuck.id)!;
      expect(job.status).toBe('failed');
      expect(job.error).toContain('Interrupted');
      expect(job.completedAt).toBeDefined();
      expect(after.getJob(queued.id)!.status).toBe('queued');
      expect(after.getJob(done.id)!.status).toBe('completed');

      // Persisted, and cleanup can now remove it once it is old.
      expect(new JobManager({ jobsFile }).getJob(stuck.id)!.status).toBe('failed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
