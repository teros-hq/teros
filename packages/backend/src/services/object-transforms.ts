/**
 * Image transforms on the object URL (docs/specs/core/platform-objects.md,
 * OBJ-REQ-3): `GET /objects/:objectId?w=&h=&fit=&format=&q=`.
 *
 * Same parameters and limits as `/static/`, but strict: an invalid value is an
 * error, not a silent "serve the original". A variant is stored next to the
 * object's file (outside the release tree) and reused.
 */

import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import { join } from "node:path"
import { type ResizeOptions, transformImageBuffer } from "../lib/image-resize"
import { objectVariantsDir } from "./platform-objects"

const MAX_DIMENSION = 4096
const FITS = ["cover", "contain", "fill", "inside", "outside"] as const
const FORMATS = ["jpeg", "jpg", "png", "webp", "avif", "gif"] as const
const TRANSFORM_PARAMS = ["w", "h", "fit", "format", "q"] as const

/** Content types a transform can be applied to. */
const RASTER_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"])

export type ObjectTransformRequest =
  | { kind: "none" }
  | { kind: "invalid"; error: string }
  | { kind: "transform"; options: ResizeOptions }

function parseIntInRange(raw: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(raw)) return null
  const n = Number.parseInt(raw, 10)
  return n >= min && n <= max ? n : null
}

/**
 * Read the transform parameters of an object request.
 * @spec OBJ-REQ-3
 */
export function parseObjectTransform(query: URLSearchParams): ObjectTransformRequest {
  if (!TRANSFORM_PARAMS.some((name) => query.has(name))) return { kind: "none" }

  const options: ResizeOptions = { fit: "cover", quality: 80 }

  for (const [name, key] of [
    ["w", "width"],
    ["h", "height"],
  ] as const) {
    const raw = query.get(name)
    if (raw === null) continue
    const value = parseIntInRange(raw, 1, MAX_DIMENSION)
    if (value === null) {
      return { kind: "invalid", error: `Invalid '${name}': an integer from 1 to ${MAX_DIMENSION}` }
    }
    options[key] = value
  }

  const fit = query.get("fit")
  if (fit !== null) {
    if (!(FITS as readonly string[]).includes(fit)) {
      return { kind: "invalid", error: `Invalid 'fit': one of ${FITS.join(", ")}` }
    }
    options.fit = fit as ResizeOptions["fit"]
  }

  const format = query.get("format")
  if (format !== null) {
    if (!(FORMATS as readonly string[]).includes(format)) {
      return { kind: "invalid", error: `Invalid 'format': one of ${FORMATS.join(", ")}` }
    }
    options.format = format as ResizeOptions["format"]
  }

  const q = query.get("q")
  if (q !== null) {
    const value = parseIntInRange(q, 1, 100)
    if (value === null) return { kind: "invalid", error: "Invalid 'q': an integer from 1 to 100" }
    options.quality = value
  }

  return { kind: "transform", options }
}

/**
 * Can a transform be applied to an object of this content type?
 * @spec OBJ-REQ-3
 */
export function isTransformableContentType(contentType: string): boolean {
  return RASTER_TYPES.has(contentType.split(";")[0].trim().toLowerCase())
}

function variantKey(options: ResizeOptions): string {
  const canonical = JSON.stringify({
    width: options.width ?? null,
    height: options.height ?? null,
    fit: options.fit ?? null,
    format: options.format ?? null,
    quality: options.quality ?? null,
  })
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32)
}

/**
 * The transformed variant of an object: read from the variants stored next to
 * its file, or produced and stored there.
 * @spec OBJ-REQ-3
 */
export async function transformObject(
  objectFilePath: string,
  contentType: string,
  options: ResizeOptions,
): Promise<{ data: Buffer; contentType: string; cached: boolean }> {
  const outputType = options.format
    ? `image/${options.format === "jpg" ? "jpeg" : options.format}`
    : contentType
  const dir = objectVariantsDir(objectFilePath)
  const variantPath = join(dir, variantKey(options))

  try {
    return { data: await fs.readFile(variantPath), contentType: outputType, cached: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }

  const data = await transformImageBuffer(await fs.readFile(objectFilePath), options)
  await fs.mkdir(dir, { recursive: true })
  // Write to a temp name and rename: a concurrent request never reads a partial variant.
  const tmp = `${variantPath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, data)
  await fs.rename(tmp, variantPath)

  return { data, contentType: outputType, cached: false }
}
