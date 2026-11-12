// src/core/detect.ts
var PDF_MAGIC = Buffer.from("%PDF");
var PNG_MAGIC = Buffer.from([137, 80, 78, 71]);
var JPEG_MAGIC = Buffer.from([255, 216, 255]);
var TIFF_LE = Buffer.from([73, 73, 42, 0]);
var TIFF_BE = Buffer.from([77, 77, 0, 42]);
var WEBP_RIFF = Buffer.from("RIFF");
var WEBP_TAG = Buffer.from("WEBP");
var GIF_MAGIC = Buffer.from("GIF8");
var BMP_MAGIC = Buffer.from("BM");
function startsWith(buf, magic, offset = 0) {
  if (buf.length < offset + magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (buf[offset + i] !== magic[i]) return false;
  }
  return true;
}
function detectInputType(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buf.length < 4) return "unknown";
  if (startsWith(buf, PDF_MAGIC)) return "pdf";
  if (startsWith(buf, PNG_MAGIC) || startsWith(buf, JPEG_MAGIC) || startsWith(buf, TIFF_LE) || startsWith(buf, TIFF_BE) || startsWith(buf, GIF_MAGIC) || startsWith(buf, BMP_MAGIC) || startsWith(buf, WEBP_RIFF) && startsWith(buf, WEBP_TAG, 8)) {
    return "image";
  }
  return "unknown";
}

// src/core/types.ts
var OcrError = class extends Error {
  constructor(message, code, cause) {
    super(message);
    this.code = code;
    this.cause = cause;
    this.name = "OcrError";
  }
  code;
  cause;
};

// src/adapters/image.adapter.ts
async function normalizeImage(input) {
  const sharp = (await import("sharp")).default;
  const img = sharp(input, { failOn: "none" }).rotate();
  const meta = await img.metadata();
  const png = await img.png().toBuffer();
  return { png, width: meta.width ?? 0, height: meta.height ?? 0 };
}

// src/adapters/pdf.adapter.ts
var MIN_EMBEDDED_CHARS = 40;
var MAX_IMAGE_OPS_SINGLE = 1;
var pdfjsModule = null;
async function loadPdfjs() {
  if (!pdfjsModule) {
    // [teros local patch — see README] pdf.js polyfills DOMMatrix / ImageData /
    // Path2D from ITS OWN nested @napi-rs/canvas (0.1.x) when they are missing,
    // while the canvases are created with our @napi-rs/canvas (1.x). A 0.1.x
    // Path2D passed to a 1.x context.fill() is rejected ("not a valid enum value
    // of type CanvasFillRule" in paintChar), so any page with real text — even a
    // scan with a one-line header — failed to render (pdf-to-images and OCR).
    // Register our classes first; pdf.js only fills in what is missing.
    const napiCanvas = await import("@napi-rs/canvas");
    for (const name of ["DOMMatrix", "ImageData", "Path2D"]) {
      if (!globalThis[name] && napiCanvas[name]) globalThis[name] = napiCanvas[name];
    }
    pdfjsModule = await import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  return pdfjsModule;
}
async function makeCanvasFactory() {
  const { createCanvas } = await import("@napi-rs/canvas");
  return class NapiCanvasFactory {
    create(width, height) {
      const canvas = createCanvas(Math.ceil(width), Math.ceil(height));
      return { canvas, context: canvas.getContext("2d") };
    }
    reset(pair, width, height) {
      pair.canvas.width = Math.ceil(width);
      pair.canvas.height = Math.ceil(height);
    }
    destroy(pair) {
      pair.canvas.width = 0;
      pair.canvas.height = 0;
    }
  };
}
var standardFontsPath;
async function getStandardFontsPath() {
  if (standardFontsPath !== void 0) return standardFontsPath;
  try {
    const { createRequire } = await import("module");
    const require2 = createRequire(import.meta.url);
    const path = await import("path");
    standardFontsPath = path.dirname(require2.resolve("pdfjs-dist/package.json")) + "/standard_fonts/";
  } catch {
    standardFontsPath = void 0;
  }
  return standardFontsPath;
}
// [teros local patch — see README] In Node, pdf.js runs a "fake worker" and
// takes its WorkerMessageHandler from `globalThis.pdfjsWorker` when present,
// caching it on first use. unpdf (used first by the MCA for digital PDFs) puts
// its own bundled pdf.js 6.x there, so this 4.x API picked up a 6.x worker:
// "The API version "4.10.38" does not match the Worker version "6.1.200"".
// Expose OUR worker while opening the document, then restore unpdf's.
var pdfjsWorkerModule = null;
async function loadPdfjsWorker() {
  if (!pdfjsWorkerModule) {
    pdfjsWorkerModule = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  }
  return pdfjsWorkerModule;
}
async function openDocument(pdfBuf) {
  const pdfjs = await loadPdfjs();
  const CanvasFactory = await makeCanvasFactory();
  const fonts = await getStandardFontsPath();
  const ownWorker = await loadPdfjsWorker();
  const previousWorker = globalThis.pdfjsWorker;
  globalThis.pdfjsWorker = { WorkerMessageHandler: ownWorker.WorkerMessageHandler };
  try {
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(pdfBuf.buffer, pdfBuf.byteOffset, pdfBuf.byteLength),
      useSystemFonts: false,
      isEvalSupported: false,
      // CLAVE (fase 0 → v0.2): la CLASE CanvasFactory aquí evita el segfault del render.
      CanvasFactory,
      ...fonts ? { standardFontDataUrl: fonts } : {}
    }).promise;
    return doc;
  } finally {
    globalThis.pdfjsWorker = previousWorker;
  }
}
function reconstructLines(items) {
  const lines = /* @__PURE__ */ new Map();
  for (const it of items) {
    if (typeof it !== "object" || it === null || !("str" in it)) continue;
    const item = it;
    if (!item.str.trim()) continue;
    const y = Math.round(item.transform?.[5] ?? 0);
    const x = item.transform?.[4] ?? 0;
    if (!lines.has(y)) lines.set(y, []);
    lines.get(y).push({ x, str: item.str });
  }
  return [...lines.entries()].sort((a, b) => b[0] - a[0]).map(
    ([, its]) => its.sort((a, b) => a.x - b.x).map((i) => i.str).join(" ").replace(/\s+/g, " ").trim()
  ).filter((l) => l.length > 0).join("\n");
}
async function countImageOps(page, pdfjs) {
  const ops = await page.getOperatorList();
  const paintOp = pdfjs.OPS.paintImageXObject;
  const paintJpeg = pdfjs.OPS.paintJpegXObject;
  let n = 0;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    if (fn === paintOp || fn === paintJpeg) n++;
  }
  return n;
}
async function extractPageImage(page, pdfjs) {
  const ops = await page.getOperatorList();
  const paintOp = pdfjs.OPS.paintImageXObject;
  const paintJpeg = pdfjs.OPS.paintJpegXObject;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    if (fn !== paintOp && fn !== paintJpeg) continue;
    const name = ops.argsArray[i][0];
    if (!name) continue;
    const obj = await new Promise((res) => {
      try {
        page.objs.get(name, (o) => res(o ?? null));
      } catch {
        res(null);
      }
    });
    if (!obj) continue;
    const { data, width, height } = obj;
    if (!data || !width || !height) continue;
    const channels = Math.round(data.length / (width * height));
    if (channels < 1 || channels > 4) continue;
    const sharp = (await import("sharp")).default;
    const png = await sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
      raw: { width, height, channels }
    }).png().toBuffer();
    return { png, width, height };
  }
  return null;
}
async function renderPage(page, scale) {
  const { createCanvas } = await import("@napi-rs/canvas");
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
  const context = canvas.getContext("2d");
  await page.render({ canvasContext: context, viewport }).promise;
  const sharp = (await import("sharp")).default;
  const png = await sharp(canvas.toBuffer("image/png")).grayscale().normalize().sharpen({ sigma: 1.2 }).withMetadata({ density: Math.round(scale * 72) }).png().toBuffer();
  return { png, width: Math.floor(viewport.width), height: Math.floor(viewport.height) };
}
async function extractPdf(pdfBuf, pages = "all", maxPages = 100, renderScale = 5) {
  const pdfjs = await loadPdfjs();
  const doc = await openDocument(pdfBuf);
  const warnings = [];
  try {
    const totalPages = doc.numPages;
    if (totalPages === 0) {
      throw new OcrError("El PDF no tiene p\xE1ginas", "EMPTY_DOCUMENT");
    }
    let wanted;
    if (pages === "all") {
      if (totalPages > maxPages) {
        warnings.push(`El documento tiene ${totalPages} p\xE1ginas; se procesan las primeras ${maxPages} (maxPages).`);
      }
      wanted = Array.from({ length: Math.min(totalPages, maxPages) }, (_, i) => i + 1);
    } else {
      wanted = pages.filter((p) => p >= 1 && p <= totalPages).slice(0, maxPages);
      const invalid = pages.filter((p) => p < 1 || p > totalPages);
      if (invalid.length) warnings.push(`P\xE1ginas fuera de rango ignoradas: ${invalid.join(", ")} (documento de ${totalPages} p\xE1ginas).`);
    }
    const out = [];
    for (const n of wanted) {
      const pageWarnings = [];
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const rawChars = content.items.reduce((acc, it) => {
        if (typeof it === "object" && it !== null && "str" in it) {
          return acc + it.str.trim().length;
        }
        return acc;
      }, 0);
      let embeddedText = null;
      if (rawChars >= MIN_EMBEDDED_CHARS) {
        embeddedText = reconstructLines(content.items);
      }
      let imagePng = null;
      let imageSource = null;
      let width;
      let height;
      if (!embeddedText) {
        const imageOps = await countImageOps(page, pdfjs);
        const pageViewport = page.getViewport({ scale: 1 });
        const doRender = async () => {
          try {
            const r = await renderPage(page, renderScale);
            imagePng = r.png;
            imageSource = "render";
            width = r.width;
            height = r.height;
            return true;
          } catch {
            pageWarnings.push("No se pudo renderizar la p\xE1gina.");
            return false;
          }
        };
        if (imageOps > MAX_IMAGE_OPS_SINGLE) {
          await doRender();
        } else if (imageOps === 1) {
          const img = await extractPageImage(page, pdfjs);
          const minDpi = 150;
          const imgDpi = img ? img.width / (pageViewport.width / 72) : 0;
          if (img && imgDpi >= minDpi) {
            imagePng = img.png;
            imageSource = "embedded-image";
            width = img.width;
            height = img.height;
          } else {
            if (img) pageWarnings.push(`Imagen embebida de baja resoluci\xF3n (~${Math.round(imgDpi)} DPI) \u2014 se usa render.`);
            await doRender();
          }
        } else {
          await doRender();
        }
      }
      out.push({ pageNumber: n, embeddedText, imagePng, imageSource, width, height, warnings: pageWarnings });
    }
    return { pages: out, totalPages, warnings };
  } finally {
    await doc.destroy();
  }
}

// [teros local patch — see README] Colour page renders for VISION models.
// renderPage() above is tuned for tesseract (grayscale + normalize + sharpen);
// a vision model wants the page as a person sees it (ink colour, stamps, pen
// corrections). Same openDocument() (CanvasFactory + pdf.js worker isolation),
// so it renders in-process without the sandbox segfault.
async function renderPdfPages(pdfBuf, options = {}) {
  const dpi = options.dpi ?? 150;
  const maxPages = options.maxPages ?? 10;
  const { createCanvas } = await import("@napi-rs/canvas");
  const doc = await openDocument(pdfBuf);
  try {
    const totalPages = doc.numPages;
    const requested = !options.pages || options.pages === "all"
      ? Array.from({ length: totalPages }, (_, i) => i + 1)
      : options.pages.filter((p) => p >= 1 && p <= totalPages);
    const wanted = requested.slice(0, maxPages);
    const pages = [];
    for (const n of wanted) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: dpi / 72 });
      const width = Math.floor(viewport.width);
      const height = Math.floor(viewport.height);
      const canvas = createCanvas(width, height);
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      await page.render({ canvasContext: context, viewport }).promise;
      pages.push({ pageNumber: n, png: canvas.toBuffer("image/png"), width, height });
      page.cleanup();
    }
    return { pages, totalPages, omitted: requested.length - wanted.length };
  } finally {
    await doc.destroy();
  }
}

// src/preprocess/pipeline.ts
var DEFAULT_PREPROCESS = {
  normalize: true,
  threshold: "auto",
  upscale: true,
  minWidth: 1500
};
async function preprocessImage(png, options = {}, forceThreshold = false) {
  if (options === false) return { png, applied: [] };
  const opts = { ...DEFAULT_PREPROCESS, ...options };
  const sharp = (await import("sharp")).default;
  const applied = [];
  let img = sharp(png);
  if (opts.normalize) {
    img = img.grayscale().normalize();
    applied.push("grayscale+normalize");
  }
  if (opts.upscale) {
    const meta = await img.metadata();
    if (meta.width && meta.width < opts.minWidth) {
      img = img.resize({ width: opts.minWidth, kernel: "lanczos3" });
      applied.push(`upscale\u2192${opts.minWidth}px`);
    }
  }
  const doThreshold = opts.threshold === true || forceThreshold && opts.threshold === "auto";
  if (doThreshold) {
    img = img.threshold(128);
    applied.push("threshold");
  }
  img = img.sharpen();
  applied.push("sharpen");
  img = img.withMetadata({ density: 300 });
  return { png: await img.png().toBuffer(), applied };
}

// src/engines/tesseract-js.engine.ts
function extractWords(data) {
  const out = [];
  for (const b of data.blocks ?? []) {
    for (const p of b.paragraphs ?? []) {
      for (const l of p.lines ?? []) {
        for (const w of l.words ?? []) {
          out.push(w);
        }
      }
    }
  }
  return out;
}
var TesseractPool = class {
  constructor(opts) {
    this.opts = opts;
  }
  opts;
  workers = [];
  queue = [];
  busy = /* @__PURE__ */ new Set();
  initPromise = null;
  async init() {
    const { createWorker } = await import("tesseract.js");
    const os = await import("os");
    const n = Math.max(1, Math.min(this.opts.workers ?? 2, os.cpus().length - 1));
    const langs = this.opts.languages.join("+");
    this.workers = await Promise.all(
      Array.from(
        { length: n },
        () => createWorker(langs, 1, {
          cachePath: this.opts.cachePath,
          logger: () => {
          },
          errorHandler: () => {
          }
        })
      )
    );
  }
  async acquire() {
    if (!this.initPromise) this.initPromise = this.init();
    await this.initPromise;
    const free = this.workers.find((w) => !this.busy.has(w));
    if (free) {
      this.busy.add(free);
      return free;
    }
    return new Promise((res) => this.queue.push(res));
  }
  release(w) {
    this.busy.delete(w);
    const next = this.queue.shift();
    if (next) {
      this.busy.add(w);
      next(w);
    }
  }
  /**
   * OCR de una página (PNG).
   * `psm`: Page Segmentation Mode de tesseract ('3' = auto, default; '4' = columna única
   * de texto de tamaño variable — CLAVE para layouts con columnas/cabeceras complejas,
   * validado en v0.2: sube la confianza de ~50% a ~85% en docs compuestos).
   */
  async recognize(png, psm = "3") {
    const worker = await this.acquire();
    const t = Date.now();
    try {
      if (psm !== "3") {
        await worker.setParameters({ tessedit_pageseg_mode: psm });
      }
      const { data } = await worker.recognize(png, {}, { blocks: true, text: true });
      if (psm !== "3") {
        await worker.setParameters({ tessedit_pageseg_mode: "3" });
      }
      const words = extractWords(data);
      const lowConfidenceWords = words.filter((w) => w.confidence > 0 && w.confidence < this.opts.lowConfidenceThreshold && w.text.trim().length > 1).map((w) => ({ text: w.text, confidence: Math.round(w.confidence) }));
      return {
        text: data.text.trim(),
        // [teros local patch — see README] An empty read is not a confident one:
        // tesseract can report ~95% with no text (seen on a PSM 4 retry of a
        // sideways page), which then "won" every retry/orientation comparison.
        confidence: data.text.trim() ? data.confidence : 0,
        lowConfidenceWords,
        durationMs: Date.now() - t
      };
    } catch (e) {
      throw new OcrError("Fallo del motor OCR (tesseract.js)", "ENGINE_FAILURE", e);
    } finally {
      this.release(worker);
    }
  }
  async dispose() {
    if (!this.initPromise) return;
    await this.initPromise;
    await Promise.allSettled(this.workers.map((w) => w.terminate()));
    this.workers = [];
    this.initPromise = null;
  }
};

// src/core/pipeline.ts
var DEFAULT_CACHE = "node_modules/.cache/teros-ocr";
var RETRY_THRESHOLD = 70;

// [teros local patch — see README] Automatic orientation for rotated scans
// (ID cards, sideways/upside-down pages). EXIF only covers camera photos; a
// rotated scan carries no orientation, so tesseract reads garbage at low
// confidence. When a page's OCR confidence is below RETRY_THRESHOLD, OCR a
// downscaled copy at 0/90/180/270° and keep the best angle if it clearly wins
// (ROTATION_MARGIN); then OCR the full-size page rotated by that angle and keep
// it only if it beats the original. Pages that read fine cost nothing extra.
// Candidates are compared against the FULL-SIZE upright confidence, not an
// upright probe: on the small probe tesseract sometimes reads 90°-rotated text
// fine, which tied with the right angle and hid it.
var ROTATION_ANGLES = [90, 180, 270];
var ROTATION_MARGIN = 10;
var ROTATION_PROBE_MAX_SIDE = 1200;
async function rotatePng(png, angle) {
  const sharp = (await import("sharp")).default;
  return sharp(png).rotate(angle).png().toBuffer();
}
async function orientationProbe(png) {
  const sharp = (await import("sharp")).default;
  return sharp(png).resize({ width: ROTATION_PROBE_MAX_SIDE, height: ROTATION_PROBE_MAX_SIDE, fit: "inside", withoutEnlargement: true }).grayscale().normalize().png().toBuffer();
}
/**
 * Best rotation angle (clockwise degrees) for `png`, or 0 if none clearly beats
 * `uprightConfidence` (the full-size upright OCR result).
 */
async function detectRotation(png, pool, uprightConfidence) {
  const probe = await orientationProbe(png);
  let best = { angle: 0, confidence: -1 };
  for (const angle of ROTATION_ANGLES) {
    const r = await pool.recognize(await rotatePng(probe, angle), "3");
    if (r.confidence > best.confidence) best = { angle, confidence: r.confidence };
  }
  return best.confidence >= uprightConfidence + ROTATION_MARGIN ? best.angle : 0;
}

// [teros local patch — see README] Orientation for VISION renders
// (pdf-to-images): fix sideways/upside-down pages before showing them to the
// model. Same rule as the OCR path: read a small probe upright; a good read
// (≥ RETRY_THRESHOLD, the usual case) means upright — one probe only. A poor
// read tries 90/180/270° and keeps the angle that reads clearly better
// (ROTATION_MARGIN). (Text-line geometry is no signal: on a sideways page
// tesseract still reports horizontal "lines" of garbage.)
async function createOrientationDetector(options = {}) {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker(options.languages ?? ["spa", "eng"], 1, {
    cachePath: options.cachePath ?? DEFAULT_CACHE,
    logger: () => {
    },
    errorHandler: () => {
    }
  });
  const confidenceOf = async (png) => {
    const { data } = await worker.recognize(png, {}, { text: true });
    return data.text.trim() ? data.confidence : 0;
  };
  return {
    /** Clockwise degrees to apply so the page reads upright (0 = leave as is). */
    async detect(png) {
      const probe = await orientationProbe(png);
      const uprightConfidence = await confidenceOf(probe);
      if (uprightConfidence >= RETRY_THRESHOLD) return 0;
      let best = { angle: 0, confidence: uprightConfidence };
      for (const angle of ROTATION_ANGLES) {
        const c = await confidenceOf(await rotatePng(probe, angle));
        if (c > best.confidence) best = { angle, confidence: c };
      }
      return best.angle !== 0 && best.confidence >= uprightConfidence + ROTATION_MARGIN ? best.angle : 0;
    },
    async dispose() {
      await worker.terminate();
    }
  };
}
async function extractText(input, options = {}) {
  const t0 = Date.now();
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buf.length === 0) throw new OcrError("Entrada vac\xEDa", "EMPTY_DOCUMENT");
  const languages = options.languages ?? ["spa"];
  const lowThreshold = options.lowConfidenceThreshold ?? 60;
  const inputType = detectInputType(buf);
  if (inputType === "unknown") {
    throw new OcrError(
      "Tipo de entrada no soportado (magic bytes no reconocidos: ni PDF ni imagen jpeg/png/tiff/webp/gif/bmp)",
      "UNSUPPORTED_INPUT"
    );
  }
  const warnings = [];
  const pages = [];
  const poolRef = { current: null };
  const getPool = () => {
    if (poolRef.current === null) {
      poolRef.current = new TesseractPool({
        languages,
        cachePath: options.cachePath ?? DEFAULT_CACHE,
        lowConfidenceThreshold: lowThreshold
      });
    }
    return poolRef.current;
  };
  const ocrPageImage = async (png, pageNumber, totalPages, alreadyPreprocessed = false) => {
    const upright = await ocrPageImageAt(png, pageNumber, totalPages, alreadyPreprocessed);
    if (options.autoRotate === false || upright.confidence >= RETRY_THRESHOLD) return upright;
    options.onProgress?.({ page: pageNumber, totalPages, stage: "orientation" });
    const angle = await detectRotation(png, getPool(), upright.confidence);
    if (angle === 0) return upright;
    const rotated = await ocrPageImageAt(await rotatePng(png, angle), pageNumber, totalPages, alreadyPreprocessed);
    if (rotated.confidence <= upright.confidence) return upright;
    rotated.rotation = angle;
    rotated.warnings.unshift(
      `P\xE1gina girada autom\xE1ticamente ${angle}\xB0 (confianza ${upright.confidence.toFixed(0)}% → ${rotated.confidence.toFixed(0)}%).`
    );
    return rotated;
  };
  const ocrPageImageAt = async (png, pageNumber, totalPages, alreadyPreprocessed = false) => {
    const pageWarnings = [];
    options.onProgress?.({ page: pageNumber, totalPages, stage: "preprocess" });
    const pre = alreadyPreprocessed ? { png } : await preprocessImage(png, options.preprocess ?? {});
    options.onProgress?.({ page: pageNumber, totalPages, stage: "ocr" });
    const psmMode = options.psm ?? "auto";
    const initialPsm = psmMode === "4" ? "4" : "3";
    let result = await getPool().recognize(pre.png, initialPsm);
    if (!alreadyPreprocessed && result.confidence < RETRY_THRESHOLD && (options.preprocess === void 0 || options.preprocess !== false && (options.preprocess.threshold ?? "auto") === "auto")) {
      const pre2 = await preprocessImage(png, options.preprocess ?? {}, true);
      const retry = await getPool().recognize(pre2.png, initialPsm);
      if (retry.confidence > result.confidence) {
        pageWarnings.push(`Reintentada con threshold: confianza ${result.confidence.toFixed(0)}% \u2192 ${retry.confidence.toFixed(0)}%.`);
        result = retry;
      }
    }
    if (result.confidence < RETRY_THRESHOLD && psmMode === "auto") {
      const retry = await getPool().recognize(pre.png, "4");
      if (retry.confidence > result.confidence) {
        pageWarnings.push(`Reintentada con PSM 4: confianza ${result.confidence.toFixed(0)}% \u2192 ${retry.confidence.toFixed(0)}%.`);
        result = retry;
      }
    }
    if (result.confidence < lowThreshold) {
      pageWarnings.push(`Confianza baja (${result.confidence.toFixed(0)}%): revisar manualmente.`);
    }
    return {
      pageNumber,
      text: result.text,
      confidence: result.confidence,
      source: "ocr",
      lowConfidenceWords: result.lowConfidenceWords,
      durationMs: result.durationMs,
      warnings: pageWarnings
    };
  };
  try {
    if (inputType === "image") {
      const norm = await normalizeImage(buf);
      pages.push(await ocrPageImage(norm.png, 1, 1));
    } else {
      const renderScale = (options.dpi ?? 360) / 72;
      const extracted = await extractPdf(buf, options.pages ?? "all", options.maxPages ?? 100, renderScale);
      warnings.push(...extracted.warnings);
      const total = extracted.pages.length;
      for (const p of extracted.pages) {
        options.onProgress?.({ page: p.pageNumber, totalPages: total, stage: "extract" });
        if (p.embeddedText) {
          pages.push({
            pageNumber: p.pageNumber,
            text: p.embeddedText,
            confidence: 100,
            source: "embedded",
            lowConfidenceWords: [],
            durationMs: 0,
            warnings: p.warnings
          });
        } else if (p.imagePng) {
          const r = await ocrPageImage(p.imagePng, p.pageNumber, total, p.imageSource === "render");
          r.warnings.unshift(...p.warnings);
          pages.push(r);
        } else {
          warnings.push(`P\xE1gina ${p.pageNumber}: sin texto ni imagen extra\xEDble \u2014 omitida.`);
          pages.push({
            pageNumber: p.pageNumber,
            text: "",
            confidence: 0,
            source: "ocr",
            lowConfidenceWords: [],
            durationMs: 0,
            warnings: [...p.warnings, "P\xE1gina omitida: sin contenido extra\xEDble."]
          });
        }
      }
    }
  } finally {
    if (poolRef.current) await poolRef.current.dispose();
  }
  const ocrPages = pages.filter((p) => p.source === "ocr" && p.confidence > 0);
  const meanConfidence = ocrPages.length ? ocrPages.reduce((a, p) => a + p.confidence, 0) / ocrPages.length : null;
  const text = pages.map((p) => p.text).filter((t) => t.length > 0).join("\n\n");
  return {
    text,
    pages,
    languages,
    inputType,
    engine: pages.every((p) => p.source === "embedded") ? "embedded-text" : "tesseract.js-wasm",
    meanConfidence,
    totalDurationMs: Date.now() - t0,
    warnings
  };
}

// src/output/format.ts
function formatPageMarkdown(page) {
  const header = `<!-- p\xE1gina ${page.pageNumber} \xB7 fuente: ${page.source === "embedded" ? "texto embebido" : "OCR"} \xB7 confianza ${page.confidence.toFixed(0)}% -->`;
  const parts = [header, "", page.text];
  if (page.lowConfidenceWords.length > 0) {
    const sample = page.lowConfidenceWords.slice(0, 15).map((w) => w.text).join(" \xB7 ");
    parts.push(
      "",
      `> \u26A0\uFE0F [${page.lowConfidenceWords.length} palabras con baja confianza en esta p\xE1gina \u2014 posible sello, firma o zona degradada. Muestra: ${sample}]`
    );
  }
  for (const w of page.warnings) {
    parts.push("", `> \u26A0\uFE0F ${w}`);
  }
  return parts.join("\n");
}
function toMarkdown(result) {
  const summary = [
    `<!-- teros-ocr \xB7 tipo: ${result.inputType} \xB7 motor: ${result.engine} \xB7 idiomas: ${result.languages.join("+")} \xB7 ${result.pages.length} p\xE1gina(s) \xB7 ${(result.totalDurationMs / 1e3).toFixed(1)} s${result.meanConfidence !== null ? ` \xB7 confianza media OCR: ${result.meanConfidence.toFixed(0)}%` : ""} -->`
  ];
  if (result.warnings.length) {
    summary.push(`<!-- \u26A0\uFE0F avisos: ${result.warnings.join(" | ")} -->`);
  }
  return [summary.join("\n"), ...result.pages.map(formatPageMarkdown)].join("\n\n") + "\n";
}
function toText(result) {
  return result.pages.map((p) => p.text).filter((t) => t.length > 0).join("\n\n");
}
function toJson(result) {
  return JSON.stringify(result, null, 2);
}
function formatResult(result, format) {
  switch (format) {
    case "markdown":
      return toMarkdown(result);
    case "json":
      return toJson(result);
    default:
      return toText(result);
  }
}
export {
  OcrError,
  createOrientationDetector,
  detectInputType,
  extractText,
  formatResult,
  renderPdfPages,
  toJson,
  toMarkdown,
  toText
};
//# sourceMappingURL=index.js.map