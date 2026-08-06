import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { ImagePipeline, getDefaultAllowedDomains, type ProcessedImage } from './ImagePipeline';

// Mock sharp
vi.mock('sharp', () => {
  return {
    default: vi.fn(() => ({
      metadata: vi.fn().mockResolvedValue({ width: 1920, height: 1080 }),
      resize: vi.fn().mockReturnThis(),
      jpeg: vi.fn().mockReturnThis(),
      png: vi.fn().mockReturnThis(),
      toBuffer: vi.fn().mockResolvedValue(Buffer.from('processed-image-data')),
    })),
  };
});

// Mock global fetch
global.fetch = vi.fn();

describe('ImagePipeline', () => {
  let pipeline: ImagePipeline;

  beforeEach(() => {
    // Pass explicit allowed domains so tests don't depend on env vars
    pipeline = new ImagePipeline({ allowedDomains: ['example.com', 'teros.ai'] });
    vi.clearAllMocks();
  });

  describe('processImages', () => {
    it('should return empty map for non-image parts', async () => {
      const result = await pipeline.processImages(
        [
          {
            id: 'p1',
            sessionID: 's1',
            messageID: 'm1',
            type: 'file',
            mime: 'application/pdf',
            url: 'https://example.com/doc.pdf',
          },
        ],
        'anthropic',
      );

      expect(result.size).toBe(0);
    });

    it('should process image parts and return base64 data', async () => {
      const mockBuffer = Buffer.from('test-image-data');
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-length': '1000' }),
        arrayBuffer: vi.fn().mockResolvedValue(mockBuffer.buffer),
      });

      const result = await pipeline.processImages(
        [
          {
            id: 'p1',
            sessionID: 's1',
            messageID: 'm1',
            type: 'file',
            mime: 'image/jpeg',
            url: 'https://example.com/photo.jpg',
          },
        ],
        'anthropic',
      );

      expect(result.size).toBe(1);
      const processed = result.get('https://example.com/photo.jpg');
      expect(processed).toBeDefined();
      expect(processed!.base64).toBeDefined();
      expect(processed!.mimeType).toMatch(/^image\/(jpeg|png)$/);
    });

    it('should skip images on download failure (404)', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: new Headers(),
      });

      const result = await pipeline.processImages(
        [
          {
            id: 'p1',
            sessionID: 's1',
            messageID: 'm1',
            type: 'file',
            mime: 'image/png',
            url: 'https://example.com/missing.png',
          },
        ],
        'openai',
      );

      expect(result.size).toBe(0);
    });

    it('should use cache for repeated URLs', async () => {
      const mockBuffer = Buffer.from('cached-image');
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-length': '1000' }),
        arrayBuffer: vi.fn().mockResolvedValue(mockBuffer.buffer),
      });

      // First call - downloads
      const result1 = await pipeline.processImages(
        [
          {
            id: 'p1',
            sessionID: 's1',
            messageID: 'm1',
            type: 'file',
            mime: 'image/jpeg',
            url: 'https://example.com/cached.jpg',
          },
        ],
        'anthropic',
      );

      // Second call - should use cache
      const result2 = await pipeline.processImages(
        [
          {
            id: 'p2',
            sessionID: 's1',
            messageID: 'm2',
            type: 'file',
            mime: 'image/jpeg',
            url: 'https://example.com/cached.jpg',
          },
        ],
        'anthropic',
      );

      expect(result1.size).toBe(1);
      expect(result2.size).toBe(1);
      expect(global.fetch).toHaveBeenCalledTimes(1); // Only fetched once
    });

    it('should truncate images exceeding Anthropic max limit (20)', async () => {
      const images = Array.from({ length: 25 }, (_, i) => ({
        id: `p${i}`,
        sessionID: 's1',
        messageID: 'm1',
        type: 'file' as const,
        mime: 'image/jpeg',
        url: `https://example.com/img${i}.jpg`,
      }));

      // Mock all fetches
      (global.fetch as any).mockImplementation(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'content-length': '1000' }),
          arrayBuffer: vi.fn().mockResolvedValue(Buffer.from('test').buffer),
        }),
      );

      const result = await pipeline.processImages(images, 'anthropic');

      // Anthropic limit is 20 images per request
      expect(result.size).toBeLessThanOrEqual(20);
    });
  });

  describe('static helpers', () => {
    it('supportsVision should detect vision-capable models with default patterns', () => {
      expect(ImagePipeline.supportsVision('claude-3-5-sonnet')).toBe(true);
      expect(ImagePipeline.supportsVision('gpt-4o')).toBe(true);
      expect(ImagePipeline.supportsVision('gemini-2.0-flash')).toBe(true);
      expect(ImagePipeline.supportsVision('gpt-3.5-turbo')).toBe(false);
      expect(ImagePipeline.supportsVision('deepseek-chat')).toBe(false);
    });
  });

  describe('configurable vision patterns', () => {
    it('instance supportsVision should use custom patterns from constructor', () => {
      const customPipeline = new ImagePipeline({
        allowedDomains: ['example.com'],
        visionPatterns: ['custom-vision', 'my-model-v'],
      });
      expect(customPipeline.supportsVision('custom-vision-pro')).toBe(true);
      expect(customPipeline.supportsVision('my-model-v2')).toBe(true);
      expect(customPipeline.supportsVision('claude-3-sonnet')).toBe(false); // default patterns not inherited
      expect(customPipeline.supportsVision('gpt-4o')).toBe(false);
    });

    it('instance supportsVision should use default patterns when none provided', () => {
      const defaultPipeline = new ImagePipeline({ allowedDomains: ['example.com'] });
      expect(defaultPipeline.supportsVision('claude-3-sonnet')).toBe(true);
      expect(defaultPipeline.supportsVision('gpt-4o')).toBe(true);
      expect(defaultPipeline.supportsVision('deepseek-chat')).toBe(false);
    });

    it('should support TEROS_VISION_MODEL_PATTERNS env override', () => {
      const originalEnv = process.env.TEROS_VISION_MODEL_PATTERNS;
      process.env.TEROS_VISION_MODEL_PATTERNS = 'env-model,another-vision';
      // Re-import to pick up env var — we test via static method which reads at module load
      // For a fresh read, we can't easily re-import, but we can verify the env var is set
      // and the static method would use it if the module were reloaded.
      // Instead, we test the instance path which reads env at construction time.
      const envPipeline = new ImagePipeline({ allowedDomains: ['example.com'] });
      expect(envPipeline.supportsVision('env-model-pro')).toBe(true);
      expect(envPipeline.supportsVision('another-vision-xl')).toBe(true);
      expect(envPipeline.supportsVision('claude-3-sonnet')).toBe(false); // defaults overridden

      // Cleanup
      if (originalEnv === undefined) {
        delete process.env.TEROS_VISION_MODEL_PATTERNS;
      } else {
        process.env.TEROS_VISION_MODEL_PATTERNS = originalEnv;
      }
    });

    it('instance and static supportsVision should behave consistently for defaults', () => {
      const defaultPipeline = new ImagePipeline({ allowedDomains: ['example.com'] });
      // Both should agree on known models when no custom patterns/env override
      expect(defaultPipeline.supportsVision('gpt-4o')).toBe(ImagePipeline.supportsVision('gpt-4o'));
      expect(defaultPipeline.supportsVision('deepseek-chat')).toBe(
        ImagePipeline.supportsVision('deepseek-chat'),
      );
    });
  });

  describe('domain validation', () => {
    it('should reject external URLs when not in allowed domains', async () => {
      const restrictedPipeline = new ImagePipeline({ allowedDomains: ['teros.ai'] });
      const result = await restrictedPipeline.processImages(
        [
          {
            id: 'p1',
            sessionID: 's1',
            messageID: 'm1',
            type: 'file',
            mime: 'image/jpeg',
            url: 'https://evil.com/malware.jpg',
          },
        ],
        'anthropic',
      );
      expect(result.size).toBe(0);
    });

    it('should accept URLs from allowed domains', async () => {
      const mockBuffer = Buffer.from('test-image-data');
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-length': '1000' }),
        arrayBuffer: vi.fn().mockResolvedValue(mockBuffer.buffer),
      });

      const restrictedPipeline = new ImagePipeline({ allowedDomains: ['teros.ai'] });
      const result = await restrictedPipeline.processImages(
        [
          {
            id: 'p1',
            sessionID: 's1',
            messageID: 'm1',
            type: 'file',
            mime: 'image/jpeg',
            url: 'https://uploads.teros.ai/image.jpg',
          },
        ],
        'anthropic',
      );
      expect(result.size).toBe(1);
    });

    it('should reject all URLs when no domains configured (fail closed)', async () => {
      const failClosedPipeline = new ImagePipeline({ allowedDomains: [] });
      const result = await failClosedPipeline.processImages(
        [
          {
            id: 'p1',
            sessionID: 's1',
            messageID: 'm1',
            type: 'file',
            mime: 'image/jpeg',
            url: 'https://example.com/photo.jpg',
          },
        ],
        'anthropic',
      );
      expect(result.size).toBe(0);
    });

    it('should reject all URLs when allowedDomains is null (fail closed)', async () => {
      const failClosedPipeline = new ImagePipeline({ allowedDomains: null });
      const result = await failClosedPipeline.processImages(
        [
          {
            id: 'p1',
            sessionID: 's1',
            messageID: 'm1',
            type: 'file',
            mime: 'image/jpeg',
            url: 'https://example.com/photo.jpg',
          },
        ],
        'anthropic',
      );
      expect(result.size).toBe(0);
    });

    it('should accept exact domain match', async () => {
      const mockBuffer = Buffer.from('test-image-data');
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({ 'content-length': '1000' }),
        arrayBuffer: vi.fn().mockResolvedValue(mockBuffer.buffer),
      });

      const restrictedPipeline = new ImagePipeline({ allowedDomains: ['teros.ai'] });
      const result = await restrictedPipeline.processImages(
        [
          {
            id: 'p1',
            sessionID: 's1',
            messageID: 'm1',
            type: 'file',
            mime: 'image/jpeg',
            url: 'https://teros.ai/image.jpg',
          },
        ],
        'anthropic',
      );
      expect(result.size).toBe(1);
    });
  });

  describe('getDefaultAllowedDomains', () => {
    const originalFileDomain = process.env.TEROS_FILE_DOMAIN;
    const originalUploadDomain = process.env.TEROS_UPLOAD_DOMAIN;
    const originalStaticBase = process.env.STATIC_BASE_URL;

    beforeEach(() => {
      delete process.env.TEROS_FILE_DOMAIN;
      delete process.env.TEROS_UPLOAD_DOMAIN;
      delete process.env.STATIC_BASE_URL;
    });

    afterAll(() => {
      if (originalFileDomain === undefined) delete process.env.TEROS_FILE_DOMAIN;
      else process.env.TEROS_FILE_DOMAIN = originalFileDomain;
      if (originalUploadDomain === undefined) delete process.env.TEROS_UPLOAD_DOMAIN;
      else process.env.TEROS_UPLOAD_DOMAIN = originalUploadDomain;
      if (originalStaticBase === undefined) delete process.env.STATIC_BASE_URL;
      else process.env.STATIC_BASE_URL = originalStaticBase;
    });

    it('returns explicit TEROS_FILE_DOMAIN when set', () => {
      process.env.TEROS_FILE_DOMAIN = 'foo.com,bar.com';
      expect(getDefaultAllowedDomains()).toEqual(['foo.com', 'bar.com']);
    });

    it('falls back to TEROS_UPLOAD_DOMAIN when TEROS_FILE_DOMAIN unset', () => {
      process.env.TEROS_UPLOAD_DOMAIN = 'legacy.com';
      expect(getDefaultAllowedDomains()).toEqual(['legacy.com']);
    });

    it('derives hostname from STATIC_BASE_URL when both domain envs unset', () => {
      process.env.STATIC_BASE_URL = 'https://be.teros.ai/static';
      expect(getDefaultAllowedDomains()).toEqual(['be.teros.ai']);
    });

    it('derives localhost from local STATIC_BASE_URL', () => {
      process.env.STATIC_BASE_URL = 'http://localhost:10001/static';
      expect(getDefaultAllowedDomains()).toEqual(['localhost']);
    });

    it('returns null when STATIC_BASE_URL is malformed', () => {
      process.env.STATIC_BASE_URL = 'not a url';
      expect(getDefaultAllowedDomains()).toBeNull();
    });

    it('returns null when all envs unset (fail-closed)', () => {
      expect(getDefaultAllowedDomains()).toBeNull();
    });

    it('TEROS_FILE_DOMAIN takes precedence over STATIC_BASE_URL', () => {
      process.env.TEROS_FILE_DOMAIN = 'explicit.com';
      process.env.STATIC_BASE_URL = 'https://other.com/static';
      expect(getDefaultAllowedDomains()).toEqual(['explicit.com']);
    });
  });

  describe('vision patterns coverage', () => {
    it('supportsVision detects Kimi K2 models on Fireworks', () => {
      expect(ImagePipeline.supportsVision('accounts/fireworks/models/kimi-k2p6')).toBe(true);
      expect(ImagePipeline.supportsVision('accounts/fireworks/models/kimi-k2p5')).toBe(true);
      expect(ImagePipeline.supportsVision('kimi-k2-instruct')).toBe(true);
    });

    it('supportsVision detects other vision-capable models', () => {
      expect(ImagePipeline.supportsVision('pixtral-12b-2409')).toBe(true);
      expect(ImagePipeline.supportsVision('llama-3.2-vision-90b')).toBe(true);
      expect(ImagePipeline.supportsVision('qwen2-vl-72b')).toBe(true);
      expect(ImagePipeline.supportsVision('qwen2.5-vl-32b')).toBe(true);
      expect(ImagePipeline.supportsVision('glm-4v-9b')).toBe(true);
    });

    it('supportsVision still rejects text-only models', () => {
      expect(ImagePipeline.supportsVision('deepseek-chat')).toBe(false);
      expect(ImagePipeline.supportsVision('gpt-3.5-turbo')).toBe(false);
      expect(ImagePipeline.supportsVision('mixtral-8x7b')).toBe(false);
      expect(ImagePipeline.supportsVision('llama-3-70b')).toBe(false);
    });
  });
});
