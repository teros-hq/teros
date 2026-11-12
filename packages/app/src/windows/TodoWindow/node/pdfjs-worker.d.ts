// pdf.js ships no types for its worker entry; it is only imported for its side effect
// (globalThis.pdfjsWorker, see pdfPage.web.ts).
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs"
