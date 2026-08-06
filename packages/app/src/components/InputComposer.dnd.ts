/**
 * TER-661 — lógica pura del drag-and-drop de archivos del composer, extraída de
 * InputComposer.web para poder testearla sin montar el grafo de UI (mismo patrón
 * que InputComposer.audio). Los listeners nativos del DOM se cablean en el
 * componente; aquí vive la decisión de qué hacer con cada DragEvent.
 *
 * Por qué HTML5 DnD nativo + addEventListener y no props de React: react-native-web
 * no reenvía los eventos drag de forma fiable (mismo motivo por el que el Kanban
 * los engancha a mano en windows/BoardWindow/KanbanColumn.tsx).
 */

/**
 * Un arrastre trae archivos externos solo si el `dataTransfer` anuncia el tipo
 * "Files". Los drags internos de la app (tabs del tiling, tarjetas del Kanban)
 * usan `text/plain` u otros tipos y NO deben activar el overlay del composer.
 */
export function dragHasFiles(e: Pick<DragEvent, "dataTransfer">): boolean {
  const dt = e.dataTransfer
  return !!dt && Array.from(dt.types).includes("Files")
}

export interface FileDropCallbacks {
  /** true cuando no se aceptan drops (composer deshabilitado o grabando audio). */
  isDropDisabled: () => boolean
  /** Muestra u oculta el overlay "suelta aquí". */
  setDragging: (dragging: boolean) => void
  /** Recibe los archivos soltados (ya validados aguas abajo por useFileUpload). */
  onFiles: (files: FileList) => void
}

export interface FileDropHandlers {
  onDragEnter: (e: DragEvent) => void
  onDragOver: (e: DragEvent) => void
  onDragLeave: (e: DragEvent) => void
  onDrop: (e: DragEvent) => void
}

/**
 * Fabrica los cuatro handlers de drag. Mantiene un contador de profundidad
 * privado porque `dragenter`/`dragleave` también disparan al cruzar los hijos
 * del composer; contar entradas y salidas evita que el overlay parpadee.
 */
export function createFileDropHandlers(cb: FileDropCallbacks): FileDropHandlers {
  let depth = 0

  return {
    onDragEnter(e) {
      if (cb.isDropDisabled() || !dragHasFiles(e)) return
      e.preventDefault()
      depth += 1
      cb.setDragging(true)
    },
    onDragOver(e) {
      if (cb.isDropDisabled() || !dragHasFiles(e)) return
      // preventDefault en dragover es obligatorio para que 'drop' se dispare.
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy"
    },
    onDragLeave(e) {
      if (!dragHasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) cb.setDragging(false)
    },
    onDrop(e) {
      // El overlay se cierra siempre, incluso si el drop se ignora por el guard.
      depth = 0
      cb.setDragging(false)
      if (cb.isDropDisabled() || !dragHasFiles(e)) return
      e.preventDefault()
      const files = e.dataTransfer?.files
      if (files && files.length > 0) cb.onFiles(files)
    },
  }
}
