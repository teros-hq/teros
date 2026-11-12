/**
 * Tipos públicos del core de @teros/ocr.
 * Diseñados para que un futuro MCA de Teros los exponga 1:1 como tool.
 */
type OcrLanguage = 'spa' | 'eng';
type InputType = 'pdf' | 'image' | 'unknown';
type PageSource = 'ocr' | 'embedded';
type OutputFormat = 'text' | 'json' | 'markdown';
interface PreprocessOptions {
    /** Escala de grises + normalización de contraste. Default: true */
    normalize?: boolean;
    /** Threshold adaptativo (binarización). Default: 'auto' — solo si la confianza inicial es baja */
    threshold?: boolean | 'auto';
    /** Upscale si la imagen es pequeña (< minWidth px de ancho). Default: true */
    upscale?: boolean;
    /** Ancho mínimo para disparar el upscale. Default: 1500 */
    minWidth?: number;
}
interface OcrOptions {
    /** Idiomas del motor OCR. Default: ['spa'] */
    languages?: OcrLanguage[];
    /** Preprocesado de imagen. `false` lo desactiva. Default: preset documento */
    preprocess?: PreprocessOptions | false;
    /** Páginas a procesar (1-indexed). Default: 'all' */
    pages?: number[] | 'all';
    /** Límite de seguridad de páginas. Default: 100 */
    maxPages?: number;
    /** Umbral de confianza (0-100) bajo el cual una zona se marca con ⚠️. Default: 60 */
    lowConfidenceThreshold?: number;
    /** Callback de progreso (para reporting del agente/MCA) */
    onProgress?: (p: {
        page: number;
        totalPages: number;
        stage: 'extract' | 'preprocess' | 'ocr' | 'orientation';
    }) => void;
    /** Directorio de caché para traineddata. Default: node_modules/.cache/teros-ocr */
    cachePath?: string;
    /**
     * Page Segmentation Mode de tesseract. Default: 'auto' (empieza en 3 y reintenta
     * en 4 si la confianza es baja — clave para layouts con columnas/cabeceras).
     * '3' = auto clásico · '4' = columna única de tamaño variable (fuerza desde el inicio).
     */
    psm?: 'auto' | '3' | '4';
    /** DPI objetivo del render de páginas PDF compuestas. Default: 360 (scale 5.0). */
    dpi?: number;
    /**
     * Orientación automática (parche local teros). Si la confianza de una página es
     * baja, prueba 0/90/180/270° y aplica el giro que mejor lee. Default: true.
     */
    autoRotate?: boolean;
}
interface OcrWord {
    text: string;
    confidence: number;
}
interface PageResult {
    pageNumber: number;
    text: string;
    /** Confianza media 0-100. Para páginas 'embedded' es 100 (texto fiel). */
    confidence: number;
    source: PageSource;
    /** Palabras/zonas bajo el umbral de confianza (solo OCR) */
    lowConfidenceWords: OcrWord[];
    durationMs: number;
    /** Avisos específicos de la página (p.ej. "sin imagen extraíble") */
    warnings: string[];
    /** Giro aplicado (grados, sentido horario) si la página se reorientó automáticamente */
    rotation?: 90 | 180 | 270;
}
interface OcrResult {
    /** Texto completo, páginas concatenadas con separadores */
    text: string;
    pages: PageResult[];
    languages: OcrLanguage[];
    /** Tipo de entrada detectado por magic bytes */
    inputType: InputType;
    engine: 'tesseract.js-wasm' | 'embedded-text';
    /** Confianza media de las páginas OCR (las embedded no cuentan) */
    meanConfidence: number | null;
    totalDurationMs: number;
    warnings: string[];
}
declare class OcrError extends Error {
    readonly code: 'UNSUPPORTED_INPUT' | 'EMPTY_DOCUMENT' | 'PAGE_WITHOUT_IMAGE' | 'ENGINE_FAILURE' | 'INVALID_OPTIONS';
    readonly cause?: unknown | undefined;
    constructor(message: string, code: 'UNSUPPORTED_INPUT' | 'EMPTY_DOCUMENT' | 'PAGE_WITHOUT_IMAGE' | 'ENGINE_FAILURE' | 'INVALID_OPTIONS', cause?: unknown | undefined);
}

declare function extractText(input: Buffer | Uint8Array, options?: OcrOptions): Promise<OcrResult>;

/**
 * Detección de tipo de entrada por magic bytes (nunca por extensión).
 */

declare function detectInputType(input: Buffer | Uint8Array): InputType;

/**
 * Formateadores de salida del OcrResult.
 *
 * El formato markdown está pensado para que un LLM lo post-procese:
 *  - separadores de página con fuente y confianza,
 *  - zonas de baja confianza marcadas con ⚠️ para que el modelo sepa
 *    qué puede reconstruir con criterio y qué no debe tocar.
 */

declare function toMarkdown(result: OcrResult): string;
declare function toText(result: OcrResult): string;
declare function toJson(result: OcrResult): string;
interface RenderedPage {
    pageNumber: number;
    /** Colour PNG of the page (white background) */
    png: Buffer;
    width: number;
    height: number;
}
/** [teros local patch] Colour page renders for vision models (see README). */
declare function renderPdfPages(pdfBuf: Buffer, options?: {
    /** 1-indexed pages, or 'all' (default) */
    pages?: number[] | 'all';
    /** Render resolution. Default 150. */
    dpi?: number;
    /** Max pages rendered per call. Default 10. */
    maxPages?: number;
}): Promise<{
    pages: RenderedPage[];
    totalPages: number;
    /** Requested pages not rendered because of maxPages */
    omitted: number;
}>;
/** [teros local patch] Orientation for vision renders (see README). */
declare function createOrientationDetector(options?: {
    languages?: OcrLanguage[];
    cachePath?: string;
}): Promise<{
    /** Clockwise degrees to apply so the page reads upright (0 = leave as is). */
    detect(png: Buffer): Promise<0 | 90 | 180 | 270>;
    dispose(): Promise<void>;
}>;
declare function formatResult(result: OcrResult, format: 'text' | 'json' | 'markdown'): string;

export { type InputType, OcrError, type OcrLanguage, type OcrOptions, type OcrResult, type OcrWord, type OutputFormat, type PageResult, type PageSource, type PreprocessOptions, createOrientationDetector, detectInputType, extractText, formatResult, renderPdfPages, type RenderedPage, toJson, toMarkdown, toText };
