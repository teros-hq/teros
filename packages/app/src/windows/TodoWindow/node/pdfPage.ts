/** Native: no inline PDF rendering (the preview falls back to a file tile). */
export function renderPdfFirstPage(_url: string, _width?: number): Promise<string | null> {
  return Promise.resolve(null)
}
