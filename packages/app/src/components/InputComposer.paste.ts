/**
 * Lógica pura del paste de imágenes del composer, extraída de
 * InputComposer.web para poder testearla sin montar el grafo de UI
 * (mismo patrón que InputComposer.dnd).
 *
 * Cuando el usuario pega (Cmd+V / Ctrl+V) y el clipboard contiene imágenes
 * (capturas de pantalla, imágenes copiadas de un navegador, etc.), las
 * extrae como File[] y las entrega al pipeline de attachments existente
 * (fileUpload.addFiles()) — igual que el file picker o el drag-and-drop.
 *
 * Solo intercepta el paste cuando hay imágenes; si el clipboard tiene texto
 * (o está vacío), el evento sigue su curso normal para no romper el paste
 * de texto en el input.
 */

/** MIME types de imagen que aceptamos del clipboard. */
const PASTEABLE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/svg+xml",
])

/**
 * Extrae los File de imagen de un ClipboardEvent.
 * Devuelve null si no hay imágenes (el paste sigue su curso normal).
 */
export function extractPastedImages(
  e: Pick<ClipboardEvent, "clipboardData">,
): File[] | null {
  const dt = e.clipboardData
  if (!dt) return null

  const files: File[] = []

  // ClipboardEvent.items es la API moderna; cada item puede ser un File.
  for (const item of Array.from(dt.items)) {
    if (item.kind !== "file") continue
    if (!PASTEABLE_IMAGE_TYPES.has(item.type)) continue

    const file = item.getAsFile()
    if (file) files.push(file)
  }

  // Fallback: algunos navegadores exponen los archivos directamente en .files
  // sin poblar .items (Safari en algunos casos).
  if (files.length === 0 && dt.files.length > 0) {
    for (const file of Array.from(dt.files)) {
      if (PASTEABLE_IMAGE_TYPES.has(file.type)) {
        files.push(file)
      }
    }
  }

  return files.length > 0 ? files : null
}

/**
 * Genera un nombre descriptivo para un archivo pegado desde el clipboard.
 * Las capturas de pantalla llegan como "image.png" sin nombre útil;
 * les damos un nombre con timestamp para que sean identificables.
 */
export function namePastedFile(file: File, index: number): File {
  const ext = file.type.split("/")[1]?.replace("svg+xml", "svg") || "png"
  const now = new Date()
  const ts = now.toISOString().slice(11, 19).replace(/:/g, "") // HHmmss
  const name = `screenshot-${ts}${index > 0 ? `-${index + 1}` : ""}.${ext}`

  // File es inmutable en nombre; creamos una copia con el nombre nuevo.
  return new File([file], name, { type: file.type })
}

export interface PasteCallbacks {
  /** true cuando no se aceptan pastes (composer deshabilitado o grabando audio). */
  isPasteDisabled: () => boolean
  /** Recibe las imágenes pegadas (ya renombradas). */
  onFiles: (files: File[]) => void
}

/**
 * Handler de paste para el composer. Si el clipboard trae imágenes, las
 * extrae, las renombra con timestamp, y las entrega al pipeline de
 * attachments. Si no hay imágenes, el evento sigue su curso (paste de texto).
 */
export function createPasteHandler(cb: PasteCallbacks) {
  return (e: ClipboardEvent) => {
    if (cb.isPasteDisabled()) return

    const images = extractPastedImages(e)
    if (!images) return

    // Hay imágenes → interceptamos el paste para que no se inserte
    // como contenido del input (sería base64 crudo o nada).
    e.preventDefault()
    cb.onFiles(images.map((f, i) => namePastedFile(f, i)))
  }
}
