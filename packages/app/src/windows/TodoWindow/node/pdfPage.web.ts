/**
 * Render the first page of a PDF to a data URL with pdf.js (web only), so a
 * file output previews as a clean page (the mock) instead of the browser's
 * PDF viewer chrome. pdf.js and its worker are lazy chunks; the worker runs
 * on the main thread (`globalThis.pdfjsWorker`), one page is cheap.
 */
const cache = new Map<string, Promise<string | null>>()

export function renderPdfFirstPage(url: string, width = 900): Promise<string | null> {
  const key = `${url}@${width}`
  let p = cache.get(key)
  if (!p) {
    p = (async () => {
      try {
        const [pdfjs, worker] = await Promise.all([
          import("pdfjs-dist/legacy/build/pdf.mjs"),
          import("pdfjs-dist/legacy/build/pdf.worker.mjs"),
        ])
        ;(globalThis as any).pdfjsWorker = worker
        const doc = await (pdfjs as any).getDocument({ url, isEvalSupported: false }).promise
        const page = await doc.getPage(1)
        const base = page.getViewport({ scale: 1 })
        const viewport = page.getViewport({ scale: width / base.width })
        const canvas = document.createElement("canvas")
        canvas.width = Math.round(viewport.width)
        canvas.height = Math.round(viewport.height)
        const ctx = canvas.getContext("2d")
        if (!ctx) return null
        await page.render({ canvasContext: ctx, viewport, canvas }).promise
        const out = canvas.toDataURL("image/png")
        void doc.destroy()
        return out
      } catch (err) {
        console.warn("[todo] PDF preview failed", err)
        cache.delete(key)
        return null
      }
    })()
    cache.set(key, p)
  }
  return p
}
