/** Input/output helpers: labels, sizes, file picking (web) and the 10 MB upload limit. */
import { Platform } from "react-native"
import type { NodeIO } from "../model/types"

export const MAX_FILE_BYTES = 10 * 1024 * 1024

export function extOf(name: string): string {
  const i = name.lastIndexOf(".")
  return i >= 0 ? name.slice(i + 1).toUpperCase() : "FILE"
}

export function ioLabel(io: NodeIO, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (io.format === "form") return t("todo.io.form", { count: io.fields.length })
  if (io.format === "file") return t("todo.io.file", { ext: extOf(io.name) })
  return t("todo.io.markdown")
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export type FileKind = "pdf" | "image" | "html" | "other"
/** How a file io previews; `html` = `.html`/`.htm` or `text/html` (@spec TODOOV-REQ-9). */
export function fileKind(mime: string, name: string): FileKind {
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) return "pdf"
  if (/\.html?$/i.test(name) || mime.toLowerCase().split(";")[0].trim() === "text/html") return "html"
  if (mime.startsWith("image/")) return "image"
  return "other"
}

export interface PickedFile {
  name: string
  mime: string
  size: number
  data: string
}

/** Open the browser file picker and read the file as base64 (web only). */
export function pickFile(): Promise<PickedFile | null> {
  if (Platform.OS !== "web" || typeof document === "undefined") return Promise.resolve(null)
  return new Promise((resolve) => {
    const input = document.createElement("input")
    input.type = "file"
    input.style.display = "none"
    input.onchange = () => {
      const file = input.files?.[0]
      input.remove()
      if (!file) return resolve(null)
      const reader = new FileReader()
      reader.onload = () => {
        const url = String(reader.result ?? "")
        const data = url.slice(url.indexOf(",") + 1)
        resolve({ name: file.name, mime: file.type || "application/octet-stream", size: file.size, data })
      }
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(file)
    }
    document.body.appendChild(input)
    input.click()
  })
}

/** Format a form value for the key → value list. */
export function formValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return ""
  if (typeof v === "boolean") return v ? "✓" : "—"
  if (Array.isArray(v)) return v.join(", ")
  return String(v)
}

/**
 * Checklist progress of a form output: ticked / total checkbox fields, null
 * without checkbox fields (TODOAP-REQ-16 — the Output tab's `done/total`).
 */
export function checklistCount(io: NodeIO | null | undefined): string | null {
  if (!io || io.format !== "form") return null
  const boxes = io.fields.filter((f) => f.type === "checkbox")
  if (!boxes.length) return null
  const done = boxes.filter((f) => io.values?.[f.id] === true).length
  return `${done}/${boxes.length}`
}
