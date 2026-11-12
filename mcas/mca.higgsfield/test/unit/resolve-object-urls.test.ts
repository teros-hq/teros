/**
 * Unit tests for resolve-object-urls helper.
 *
 * Regression test for the bug where higgsfield-run received
 *   image = "http://localhost:3000/objects/obj_..."
 * and Replicate failed with `connection refused` because localhost
 * is not reachable from the external Higgsfield API.
 */

import { describe, expect, it } from 'bun:test';
import {
  MAX_DATA_URI_BYTES,
  type ObjectStorageLike,
  parseInternalObjectUrl,
  resolveInternalObjectUrls,
  resolveObjectUrlToDataUri,
} from '../../src/lib/resolve-object-urls';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function makeObjectsStorage(
  map: Record<string, { data: Buffer; contentType?: string }>,
): ObjectStorageLike {
  return {
    async get(objectId: string) {
      const entry = map[objectId];
      if (!entry) {
        return { success: false, data: null, error: 'not found' };
      }
      return { success: true, data: entry.data, contentType: entry.contentType };
    },
  };
}

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG magic
  0x00, 0x00, 0x00, 0x0d,
]);

// -----------------------------------------------------------------------------
// parseInternalObjectUrl
// -----------------------------------------------------------------------------

describe('parseInternalObjectUrl', () => {
  it('matches http://localhost:3000/objects/obj_*', () => {
    const r = parseInternalObjectUrl('http://localhost:3000/objects/obj_abc123');
    expect(r).not.toBeNull();
    expect(r!.objectId).toBe('obj_abc123');
  });

  it('matches http://127.0.0.1:3000/objects/obj_*', () => {
    const r = parseInternalObjectUrl('http://127.0.0.1:3000/objects/obj_xyz');
    expect(r).not.toBeNull();
    expect(r!.objectId).toBe('obj_xyz');
  });

  it('matches any port and https', () => {
    expect(parseInternalObjectUrl('http://localhost:9999/objects/obj_a')!.objectId).toBe('obj_a');
    expect(parseInternalObjectUrl('https://localhost/objects/obj_b')!.objectId).toBe('obj_b');
    expect(parseInternalObjectUrl('http://127.0.0.1/objects/obj_c')!.objectId).toBe('obj_c');
  });

  it('tolerates trailing slash and query string', () => {
    expect(parseInternalObjectUrl('http://localhost:3000/objects/obj_d/')!.objectId).toBe('obj_d');
    expect(
      parseInternalObjectUrl('http://localhost:3000/objects/obj_e?download=1')!.objectId,
    ).toBe('obj_e');
  });

  it('rejects public URLs', () => {
    expect(parseInternalObjectUrl('https://files.example.com/objects/obj_abc')).toBeNull();
    expect(parseInternalObjectUrl('https://example.com/objects/obj_abc')).toBeNull();
    expect(parseInternalObjectUrl('https://replicate.delivery/x/y.png')).toBeNull();
  });

  it('rejects non-URL strings', () => {
    expect(parseInternalObjectUrl('a cat')).toBeNull();
    expect(parseInternalObjectUrl('')).toBeNull();
    expect(parseInternalObjectUrl('data:image/png;base64,iVBORw0KGgo=')).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// resolveObjectUrlToDataUri
// -----------------------------------------------------------------------------

describe('resolveObjectUrlToDataUri', () => {
  it('converts an internal URL to a data URI with the right mime', async () => {
    const objects = makeObjectsStorage({
      obj_abc123: { data: PNG_BYTES, contentType: 'image/png' },
    });
    const out = await resolveObjectUrlToDataUri(
      { url: 'http://localhost:3000/objects/obj_abc123', objectId: 'obj_abc123' },
      objects,
    );
    expect(out.startsWith('data:image/png;base64,')).toBe(true);
    const b64 = out.slice('data:image/png;base64,'.length);
    expect(Buffer.from(b64, 'base64').equals(PNG_BYTES)).toBe(true);
  });

  it('falls back to application/octet-stream when contentType is missing', async () => {
    const objects = makeObjectsStorage({ obj_x: { data: PNG_BYTES } });
    const out = await resolveObjectUrlToDataUri(
      { url: 'http://localhost:3000/objects/obj_x', objectId: 'obj_x' },
      objects,
    );
    expect(out.startsWith('data:application/octet-stream;base64,')).toBe(true);
  });

  it('throws an actionable error when the object does not exist', async () => {
    const objects = makeObjectsStorage({});
    await expect(
      resolveObjectUrlToDataUri(
        { url: 'http://localhost:3000/objects/obj_missing', objectId: 'obj_missing' },
        objects,
      ),
    ).rejects.toThrow(/Cannot resolve internal objects URL/);
  });

  it('throws an actionable error when the object exceeds the size cap', async () => {
    const big = Buffer.alloc(MAX_DATA_URI_BYTES + 1, 0x41);
    const objects = makeObjectsStorage({
      obj_big: { data: big, contentType: 'video/mp4' },
    });
    await expect(
      resolveObjectUrlToDataUri(
        { url: 'http://localhost:3000/objects/obj_big', objectId: 'obj_big' },
        objects,
      ),
    ).rejects.toThrow(/above the 10 MB limit/);
  });
});

// -----------------------------------------------------------------------------
// resolveInternalObjectUrls — recursive rewrite
// -----------------------------------------------------------------------------

describe('resolveInternalObjectUrls', () => {
  it('rewrites a top-level image URL (the original higgsfield-run bug)', async () => {
    const objects = makeObjectsStorage({
      obj_abc123: { data: PNG_BYTES, contentType: 'image/png' },
    });
    const input = {
      prompt: 'a cat riding a skateboard',
      image: 'http://localhost:3000/objects/obj_abc123',
    };
    const out = await resolveInternalObjectUrls(input, objects);
    expect(out.prompt).toBe('a cat riding a skateboard');
    expect(out.image.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('rewrites URLs nested in arrays (e.g. input_images)', async () => {
    const objects = makeObjectsStorage({
      obj_a: { data: PNG_BYTES, contentType: 'image/png' },
      obj_b: { data: PNG_BYTES, contentType: 'image/png' },
    });
    const input = {
      input_images: [
        'http://localhost:3000/objects/obj_a',
        'http://127.0.0.1:3000/objects/obj_b',
        'https://example.com/public.png', // untouched
      ],
    };
    const out = await resolveInternalObjectUrls(input, objects);
    expect(out.input_images[0].startsWith('data:image/png;base64,')).toBe(true);
    expect(out.input_images[1].startsWith('data:image/png;base64,')).toBe(true);
    expect(out.input_images[2]).toBe('https://example.com/public.png');
  });

  it('rewrites URLs nested deep in objects', async () => {
    const objects = makeObjectsStorage({
      obj_deep: { data: PNG_BYTES, contentType: 'image/png' },
    });
    const input = {
      config: {
        reference: {
          image: 'http://localhost:3000/objects/obj_deep',
        },
        strength: 0.7,
      },
    };
    const out = await resolveInternalObjectUrls(input, objects);
    expect(out.config.reference.image.startsWith('data:image/png;base64,')).toBe(true);
    expect(out.config.strength).toBe(0.7);
  });

  it('leaves public URLs untouched (no objects.get call)', async () => {
    let calls = 0;
    const objects: ObjectStorageLike = {
      async get() {
        calls++;
        return { success: true, data: PNG_BYTES, contentType: 'image/png' };
      },
    };
    const input = {
      image: 'https://files.example.com/objects/obj_abc123',
      other: 'https://replicate.delivery/x/y.png',
    };
    const out = await resolveInternalObjectUrls(input, objects);
    expect(out.image).toBe('https://files.example.com/objects/obj_abc123');
    expect(out.other).toBe('https://replicate.delivery/x/y.png');
    expect(calls).toBe(0);
  });

  it('leaves data URIs untouched', async () => {
    let calls = 0;
    const objects: ObjectStorageLike = {
      async get() {
        calls++;
        return { success: true, data: PNG_BYTES };
      },
    };
    const input = { image: 'data:image/png;base64,iVBORw0KGgo=' };
    const out = await resolveInternalObjectUrls(input, objects);
    expect(out.image).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(calls).toBe(0);
  });

  it('does not mutate the original input', async () => {
    const objects = makeObjectsStorage({
      obj_abc: { data: PNG_BYTES, contentType: 'image/png' },
    });
    const input = { image: 'http://localhost:3000/objects/obj_abc' };
    const snapshot = JSON.stringify(input);
    await resolveInternalObjectUrls(input, objects);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('propagates the error when the object is too large', async () => {
    const big = Buffer.alloc(MAX_DATA_URI_BYTES + 1, 0x42);
    const objects = makeObjectsStorage({
      obj_big: { data: big, contentType: 'video/mp4' },
    });
    await expect(
      resolveInternalObjectUrls(
        { video: 'http://localhost:3000/objects/obj_big' },
        objects,
      ),
    ).rejects.toThrow(/above the 10 MB limit/);
  });
});
