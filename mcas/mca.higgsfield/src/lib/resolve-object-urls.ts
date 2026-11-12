/**
 * resolve-object-urls.ts
 *
 * External AI services (Replicate, Higgsfield, ...) cannot reach internal
 * Teros URLs such as `http://localhost:3000/objects/obj_...` — those hosts
 * only resolve inside the Teros network.
 *
 * This helper scans the tool `input` payload for any string that points to
 * an internal objects URL, downloads the bytes through `ctx.objects.get()`
 * (which talks to the backend over the internal channel) and rewrites the
 * value as a `data:<mime>;base64,...` URI, which external APIs accept as
 * an image/video input.
 *
 * If the object is larger than `MAX_DATA_URI_BYTES` the data URI becomes
 * impractical (huge JSON payloads, some providers cap input size). In that
 * case we throw an actionable error telling the caller to use a public URL
 * instead.
 */

export interface ObjectStorageLike {
  get(objectId: string): Promise<{
    success: boolean;
    data: Buffer | null;
    contentType?: string;
    metadata?: Record<string, string>;
    error?: string;
  }>;
}

/** Maximum object size (in bytes) that we will inline as a data URI. */
export const MAX_DATA_URI_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Matches internal Teros object URLs:
 *   http://localhost:3000/objects/obj_abc123
 *   http://127.0.0.1:3000/objects/obj_abc123
 *   https://localhost/objects/obj_abc123
 * Any port, http or https. Captures the objectId in group 1.
 */
const INTERNAL_OBJECT_URL_RE =
  /^(https?):\/\/(localhost|127\.0\.0\.1)(?::\d+)?\/objects\/([A-Za-z0-9_\-]+)\/?(?:\?.*)?$/;

export interface InternalObjectRef {
  url: string;
  objectId: string;
}

/** Return the objectId if `value` is an internal objects URL, else null. */
export function parseInternalObjectUrl(value: string): InternalObjectRef | null {
  if (typeof value !== 'string') return null;
  const m = INTERNAL_OBJECT_URL_RE.exec(value.trim());
  if (!m) return null;
  return { url: value, objectId: m[3] };
}

/**
 * Resolve a single internal objects URL to a data URI by fetching bytes
 * through the objects storage channel.
 *
 * Throws an Error with an actionable message if the object is missing or
 * exceeds the data-URI size cap.
 */
export async function resolveObjectUrlToDataUri(
  ref: InternalObjectRef,
  objects: ObjectStorageLike,
): Promise<string> {
  const result = await objects.get(ref.objectId);

  if (!result || result.success === false || !result.data) {
    const reason = result?.error || 'object not found or empty';
    throw new Error(
      `Cannot resolve internal objects URL "${ref.url}": ${reason}. ` +
        `Provide a publicly reachable URL (https://...) or a data: URI instead.`,
    );
  }

  const size = result.data.length;
  if (size > MAX_DATA_URI_BYTES) {
    const mb = (size / (1024 * 1024)).toFixed(2);
    throw new Error(
      `Cannot inline "${ref.url}" as a data URI: object is ${mb} MB, above the ` +
        `${MAX_DATA_URI_BYTES / (1024 * 1024)} MB limit. ` +
        `Re-upload the file so it gets a public URL (https://<env>-be.teros.ai/objects/...) ` +
        `or pass a publicly reachable URL directly.`,
    );
  }

  const contentType = result.contentType || 'application/octet-stream';
  return `data:${contentType};base64,${result.data.toString('base64')}`;
}

/**
 * Walk `input` recursively and rewrite any string value that is an internal
 * objects URL into a data URI. Returns a NEW object (does not mutate input).
 *
 * Strings that are not internal objects URLs are returned untouched.
 */
export async function resolveInternalObjectUrls<T>(
  input: T,
  objects: ObjectStorageLike,
): Promise<T> {
  if (input === null || input === undefined) return input;

  if (typeof input === 'string') {
    const ref = parseInternalObjectUrl(input);
    if (!ref) return input;
    const dataUri = await resolveObjectUrlToDataUri(ref, objects);
    return dataUri as unknown as T;
  }

  if (Array.isArray(input)) {
    const out: unknown[] = new Array(input.length);
    for (let i = 0; i < input.length; i++) {
      out[i] = await resolveInternalObjectUrls(input[i], objects);
    }
    return out as unknown as T;
  }

  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = await resolveInternalObjectUrls(v, objects);
    }
    return out as unknown as T;
  }

  // numbers, booleans, etc.
  return input;
}
