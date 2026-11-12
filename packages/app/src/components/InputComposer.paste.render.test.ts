import { describe, expect, it, vi } from "vitest"
import {
  createPasteHandler,
  extractPastedImages,
  namePastedFile,
  type PasteCallbacks,
} from "./InputComposer.paste"

/**
 * Tests de la lógica pura del paste de imágenes del composer (extraída de
 * InputComposer.web para testear sin el grafo de UI, igual que
 * InputComposer.dnd.render.test.ts).
 */

/** File fake con tipo configurable. */
const file = (name: string, type: string) => new File(["x"], name, { type })

/** ClipboardItem fake. */
function fakeItem(kind: string, type: string, f?: File) {
  return {
    kind,
    type,
    getAsFile: () => f ?? file("image.png", type),
  } as unknown as DataTransferItem
}

/** ClipboardEvent fake con items y/o files configurables. */
function fakeClipboardEvent(opts: {
  items?: DataTransferItem[]
  files?: File[]
} = {}) {
  const { items = [], files = [] } = opts
  return {
    preventDefault: vi.fn(),
    clipboardData: {
      items: items as unknown as DataTransferItemList,
      files: files as unknown as FileList,
    },
  } as unknown as ClipboardEvent & { preventDefault: ReturnType<typeof vi.fn> }
}

function makeHarness() {
  const onFiles = vi.fn<(files: File[]) => void>()
  const state = { disabled: false }
  const cb: PasteCallbacks = {
    isPasteDisabled: () => state.disabled,
    onFiles,
  }
  return { onFiles, state, handler: createPasteHandler(cb) }
}

describe("extractPastedImages", () => {
  it("extrae imágenes del clipboard via items", () => {
    const e = fakeClipboardEvent({
      items: [fakeItem("file", "image/png")],
    })
    const result = extractPastedImages(e)
    expect(result).toHaveLength(1)
    expect(result![0].type).toBe("image/png")
  })

  it("acepta múltiples formatos de imagen", () => {
    const e = fakeClipboardEvent({
      items: [
        fakeItem("file", "image/png"),
        fakeItem("file", "image/jpeg"),
        fakeItem("file", "image/webp"),
      ],
    })
    expect(extractPastedImages(e)).toHaveLength(3)
  })

  it("devuelve null para texto plano (no intercepta el paste de texto)", () => {
    const e = fakeClipboardEvent({
      items: [fakeItem("string", "text/plain")],
    })
    expect(extractPastedImages(e)).toBeNull()
  })

  it("devuelve null para archivos que no son imagen", () => {
    const e = fakeClipboardEvent({
      items: [fakeItem("file", "application/pdf")],
    })
    expect(extractPastedImages(e)).toBeNull()
  })

  it("devuelve null sin clipboardData", () => {
    expect(extractPastedImages({ clipboardData: null } as any)).toBeNull()
  })

  it("fallback a .files cuando .items está vacío (Safari)", () => {
    const f = file("screenshot.png", "image/png")
    const e = fakeClipboardEvent({ items: [], files: [f] })
    const result = extractPastedImages(e)
    expect(result).toHaveLength(1)
    expect(result![0]).toBe(f)
  })

  it("fallback a .files ignora no-imágenes", () => {
    const e = fakeClipboardEvent({
      items: [],
      files: [file("doc.pdf", "application/pdf")],
    })
    expect(extractPastedImages(e)).toBeNull()
  })
})

describe("namePastedFile", () => {
  it("genera nombre con timestamp para la primera imagen", () => {
    const f = file("image.png", "image/png")
    const named = namePastedFile(f, 0)
    expect(named.name).toMatch(/^screenshot-\d{6}\.png$/)
    expect(named.type).toBe("image/png")
  })

  it("añade índice para imágenes adicionales", () => {
    const f = file("image.png", "image/png")
    expect(namePastedFile(f, 1).name).toMatch(/^screenshot-\d{6}-2\.png$/)
    expect(namePastedFile(f, 2).name).toMatch(/^screenshot-\d{6}-3\.png$/)
  })

  it("mapea svg+xml a extensión .svg", () => {
    const f = file("image.svg", "image/svg+xml")
    expect(namePastedFile(f, 0).name).toMatch(/\.svg$/)
  })

  it("preserva el contenido del archivo", () => {
    const f = file("image.png", "image/png")
    const named = namePastedFile(f, 0)
    expect(named.size).toBe(f.size)
    expect(named.type).toBe(f.type)
  })
})

describe("createPasteHandler", () => {
  it("intercepta el paste cuando hay imágenes y las entrega renombradas", () => {
    const { onFiles, handler } = makeHarness()
    const e = fakeClipboardEvent({
      items: [fakeItem("file", "image/png")],
    })

    handler(e)

    expect(e.preventDefault).toHaveBeenCalledOnce()
    expect(onFiles).toHaveBeenCalledOnce()
    const files = onFiles.mock.calls[0][0]
    expect(files).toHaveLength(1)
    expect(files[0].name).toMatch(/^screenshot-\d{6}\.png$/)
  })

  it("NO intercepta cuando el clipboard tiene texto (paste de texto normal)", () => {
    const { onFiles, handler } = makeHarness()
    const e = fakeClipboardEvent({
      items: [fakeItem("string", "text/plain")],
    })

    handler(e)

    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(onFiles).not.toHaveBeenCalled()
  })

  it("NO intercepta cuando el composer está deshabilitado", () => {
    const { onFiles, state, handler } = makeHarness()
    state.disabled = true
    const e = fakeClipboardEvent({
      items: [fakeItem("file", "image/png")],
    })

    handler(e)

    expect(e.preventDefault).not.toHaveBeenCalled()
    expect(onFiles).not.toHaveBeenCalled()
  })

  it("maneja múltiples imágenes pegadas a la vez", () => {
    const { onFiles, handler } = makeHarness()
    const e = fakeClipboardEvent({
      items: [
        fakeItem("file", "image/png"),
        fakeItem("file", "image/jpeg"),
      ],
    })

    handler(e)

    expect(onFiles).toHaveBeenCalledOnce()
    const files = onFiles.mock.calls[0][0]
    expect(files).toHaveLength(2)
    expect(files[0].name).toMatch(/^screenshot-\d{6}\.png$/)
    expect(files[1].name).toMatch(/^screenshot-\d{6}-2\.jpeg$/)
  })
})
