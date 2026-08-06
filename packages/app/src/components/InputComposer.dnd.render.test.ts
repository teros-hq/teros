import { describe, expect, it, vi } from "vitest"
import { createFileDropHandlers, dragHasFiles, type FileDropCallbacks } from "./InputComposer.dnd"

/**
 * TER-661 — lógica pura del drag-and-drop del composer (extraída de
 * InputComposer.web para testear sin el grafo de UI, igual que InputComposer.audio).
 * El overlay y el cableado de listeners al DOM son territorio smoke/e2e (arrastre
 * real desde el Finder); aquí se muerde la decisión por evento.
 */

type FakeDragEvent = DragEvent & {
  preventDefault: ReturnType<typeof vi.fn>
  dataTransfer: DataTransfer & { dropEffect: string; files: FileList }
}

/** DragEvent fake: types anuncia (o no) "Files"; files es el FileList soltado. */
function fakeDragEvent(opts: { types?: string[]; files?: File[] } = {}): FakeDragEvent {
  const { types = [], files = [] } = opts
  return {
    preventDefault: vi.fn(),
    dataTransfer: {
      types,
      files: files as unknown as FileList,
      dropEffect: "none",
    },
  } as unknown as FakeDragEvent
}

const file = (name: string) => new File(["x"], name, { type: "text/plain" })

/** Callbacks con estado mutable para no repetir el cableado en cada test. */
function makeHarness() {
  const onFiles = vi.fn<(files: FileList) => void>()
  const setDragging = vi.fn<(dragging: boolean) => void>()
  const state = { disabled: false }
  const cb: FileDropCallbacks = {
    isDropDisabled: () => state.disabled,
    setDragging,
    onFiles,
  }
  return { onFiles, setDragging, state, handlers: createFileDropHandlers(cb) }
}

describe("dragHasFiles — solo arrastres de archivos externos", () => {
  it("true cuando dataTransfer.types incluye 'Files'", () => {
    expect(dragHasFiles(fakeDragEvent({ types: ["Files"] }))).toBe(true)
  })
  it("false para drags internos (text/plain: tabs, tarjetas Kanban)", () => {
    expect(dragHasFiles(fakeDragEvent({ types: ["text/plain"] }))).toBe(false)
  })
  it("false sin dataTransfer", () => {
    expect(dragHasFiles({ dataTransfer: null } as unknown as DragEvent)).toBe(false)
  })
})

describe("onDrop", () => {
  it("entrega EXACTAMENTE el FileList soltado y cierra el overlay", () => {
    const { onFiles, setDragging, handlers } = makeHarness()
    const files = [file("a.txt"), file("b.png")]
    const e = fakeDragEvent({ types: ["Files"], files })

    handlers.onDrop(e)

    expect(e.preventDefault).toHaveBeenCalledOnce()
    expect(onFiles).toHaveBeenCalledOnce()
    // El mismo FileList, sin recortes ni copias.
    expect(onFiles.mock.calls[0][0]).toBe(e.dataTransfer.files)
    expect(Array.from(onFiles.mock.calls[0][0])).toEqual(files)
    expect(setDragging).toHaveBeenLastCalledWith(false)
  })

  it("un drag interno (sin 'Files') no entrega archivos", () => {
    const { onFiles, handlers } = makeHarness()
    handlers.onDrop(fakeDragEvent({ types: ["text/plain"], files: [file("x.txt")] }))
    expect(onFiles).not.toHaveBeenCalled()
  })
})

describe("activación del overlay", () => {
  it("dragenter con archivos muestra el overlay y llama preventDefault", () => {
    const { setDragging, handlers } = makeHarness()
    const e = fakeDragEvent({ types: ["Files"] })

    handlers.onDragEnter(e)

    expect(setDragging).toHaveBeenCalledWith(true)
    expect(e.preventDefault).toHaveBeenCalledOnce()
  })

  it("MUERDE: un drag interno (sin 'Files') NO activa el overlay ni preventDefault", () => {
    const { setDragging, handlers } = makeHarness()
    const e = fakeDragEvent({ types: ["text/plain"] })

    handlers.onDragEnter(e)
    handlers.onDragOver(e)

    expect(setDragging).not.toHaveBeenCalled()
    expect(e.preventDefault).not.toHaveBeenCalled()
  })

  it("dragover pone dropEffect='copy' y preventDefault (para que 'drop' dispare)", () => {
    const { handlers } = makeHarness()
    const e = fakeDragEvent({ types: ["Files"] })

    handlers.onDragOver(e)

    expect(e.preventDefault).toHaveBeenCalledOnce()
    expect(e.dataTransfer.dropEffect).toBe("copy")
  })
})

describe("contador de profundidad — sin parpadeo al cruzar hijos", () => {
  it("enter x2 (hijos) → 1er leave sigue mostrando; 2o leave lo cierra", () => {
    const { setDragging, handlers } = makeHarness()
    const enter = () => handlers.onDragEnter(fakeDragEvent({ types: ["Files"] }))
    const leave = () => handlers.onDragLeave(fakeDragEvent({ types: ["Files"] }))

    enter() // entra al composer
    enter() // entra a un hijo
    leave() // sale del hijo → sigue dentro
    expect(setDragging).not.toHaveBeenCalledWith(false)

    leave() // sale del composer → cierra
    expect(setDragging).toHaveBeenLastCalledWith(false)
  })
})

describe("guard: composer deshabilitado o grabando audio", () => {
  it("drop no entrega archivos, pero cierra el overlay igualmente", () => {
    const h = makeHarness()
    h.state.disabled = true
    const e = fakeDragEvent({ types: ["Files"], files: [file("a.txt")] })

    h.handlers.onDrop(e)

    expect(h.onFiles).not.toHaveBeenCalled()
    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(h.setDragging).toHaveBeenLastCalledWith(false)
  })

  it("dragenter no muestra el overlay", () => {
    const h = makeHarness()
    h.state.disabled = true
    h.handlers.onDragEnter(fakeDragEvent({ types: ["Files"] }))
    expect(h.setDragging).not.toHaveBeenCalled()
  })
})
