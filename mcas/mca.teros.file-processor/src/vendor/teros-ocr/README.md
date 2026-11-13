# Vendored @teros/ocr 0.2.0

Built ESM output (`dist/index.js` + `dist/index.d.ts`) of `@teros/ocr` 0.2.0,
vendored into this MCA instead of depending on `@teros/ocr` (previously
`file:./teros-ocr-0.2.0.tgz`).

Why: containerized MCAs run with the dependencies baked into the
`teros/mca-runtime` image (`/opt/mca-deps/node_modules`). The image's
dependency union (`scripts/gen-mca-union-deps.mjs`) skips every `@teros/*`
package — it assumes they are monorepo SDKs linked at runtime, and only
shared / mca-sdk / workflows are — so `@teros/ocr` and its dependencies were
never installed in the container. `import('@teros/ocr')` failed and scanned
PDFs silently fell back to LLM (Claude) OCR; `ocr-extract` failed outright.
The `.tgz` also broke `yarn install --frozen-lockfile` in CI (Dockerfile.test
installs before copying `mcas/`).

Vendoring keeps the fix inside this MCA: the library's npm dependencies
(`tesseract.js`, `pdfjs-dist`, `@napi-rs/canvas`, `sharp`) are declared in this
MCA's package.json, so the union picks them up like any other MCA dependency.

To update: rebuild @teros/ocr and copy its `dist/index.js` and `dist/index.d.ts`
here, keeping the dependency ranges in package.json in sync with its own.

## Related pin: `unpdf` ~1.8.1

The library needs `@napi-rs/canvas` 1.x. The image installs with npm, which
fails on the `unpdf` peer range unless unpdf is ≥ 1.8.0 (`^0.1.69 || ^1.0.0`).
unpdf 1.9.x uses the `Iterator` global, which the runtime's Node 20 lacks
("Serverless PDF.js bundle could not be resolved: ReferenceError: Iterator is
not defined" → digital-PDF text extraction breaks). Hence `~1.8.1`: 1.8.x only.
Revisit when the runtime image moves to Node 22+.

## Local patch in `index.js`: pdf.js worker isolation

`openDocument()` temporarily exposes this library's own pdf.js 4.x worker on
`globalThis.pdfjsWorker` and restores the previous value afterwards. unpdf
(which the MCA runs first, to look for a text layer) registers its bundled
pdf.js 6.x worker there, and pdf.js 4.x would otherwise pick it up and fail with
"The API version "4.10.38" does not match the Worker version "6.1.200"" — so
every scanned PDF failed local OCR. Keep this patch when updating the file.

## Local patch in `index.js`: automatic orientation (rotated scans)

`extractText()` → `ocrPageImage()` now reorients pages that read badly. If a
page's OCR confidence is below `RETRY_THRESHOLD` (70), it OCRs a downscaled
copy (≤1200px) at 0/90/180/270°, and if one angle beats upright by
`ROTATION_MARGIN` (10 points) it re-OCRs the full-size page rotated by that
angle, keeping it only if it scores higher. The page gets `rotation` and a
warning ("Página girada automáticamente 90° …"). Pages that read fine cost
nothing extra. Applies to images and PDF pages alike (both go through
`ocrPageImage`); PDF→image rendering happens in-process with the patched
CanvasFactory, which is why this lives here and not in an external script.
Disable with `autoRotate: false`. EXIF orientation of photos is still handled
earlier by `normalizeImage()`.

## Local patch in `index.js`: empty reads score 0

`TesseractPool.recognize()` reports confidence 0 when the recognized text is
empty. tesseract can return ~95% with no text (seen on the PSM 4 retry of a
sideways page), and that empty result then won every retry/orientation
comparison and the page came back blank.

## Local patch in `index.js`: one @napi-rs/canvas for pdf.js

`loadPdfjs()` registers DOMMatrix / ImageData / Path2D from OUR
`@napi-rs/canvas` (1.x, the one that creates the canvases) before importing
pdf.js. Otherwise pdf.js polyfills them from its own nested copy (0.1.x), and a
0.1.x `Path2D` passed to a 1.x `context.fill()` throws "not a valid enum value
of type CanvasFillRule" (`paintChar`) — any page with real text (even a scan
with a one-line browser header) failed to render, for OCR and pdf-to-images.

## Local addition: `renderPdfPages()` (colour renders for vision)

Exported for the MCA's `pdf-to-images` tool: colour pages on a white
background at a chosen dpi, capped by `maxPages`, via the same `openDocument()`.

## Local patch in `index.js`: offline language data + bounded start

tesseract.js downloads `<lang>.traineddata` from `cdn.jsdelivr.net` the first
time a worker starts. When that download cannot finish (no route to the CDN,
DNS, a proxy), `createWorker` never settles — errors go to `errorHandler` — so
every OCR and orientation call hung forever: production `pdf-to-images` with
`autoRotate` failed, and OCR jobs stayed `processing` indefinitely.

- `spa` and `eng` ship with this MCA in `tessdata/` (`4.0.0_best_int`, the
  variant tesseract.js fetches for OEM 1, from
  `https://cdn.jsdelivr.net/npm/@tesseract.js-data/<lang>/4.0.0_best_int/`) and
  are read from disk (`langPath`). Any other language still downloads.
  sha256: spa `40be52f97b5d4eb7460073dc1f94cd546b27150333c0bf854ed7e7132db6bceb`,
  eng `45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91`.
- `startTesseractWorker()` bounds the start (`WORKER_START_TIMEOUT_MS`, 30 s):
  past it, an `OcrError` (`ENGINE_FAILURE`) instead of a hang.
- `TesseractPool` no longer caches a failed start: the next call starts again.

Keep this patch when updating the file.
