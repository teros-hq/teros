/**
 * Image attachment reference (Pieza 1) tests.
 *
 * When a user uploads an image, the agent previously received only the base64
 * image block — never the filename/URL — so it could not locate or copy the
 * file. persistToSessionStore now writes a reference TextPart alongside the
 * FilePart (mirroring the non-image branch), with the filename escaped to
 * prevent markdown/prompt injection.
 *
 * Strategy: invoke the private persistToSessionStore through
 * `(MessageHandler.prototype as any).METHOD.call(stub, ...)` with a minimal
 * `this` carrying only the sessionStore the method touches.
 */

import { describe, expect, it, mock } from 'bun:test'
import { MessageHandler } from '../../src/handlers/message-handler'

function makeStub() {
  const parts: any[] = []
  const stub = {
    sessionStore: {
      writeMessage: mock(async () => {}),
      writePart: mock(async (p: any) => {
        parts.push(p)
      }),
    },
  }
  return { stub, parts }
}

async function persist(stub: any, content: unknown) {
  await (MessageHandler.prototype as any).persistToSessionStore.call(stub, 'ch_test', {
    messageId: 'msg_test',
    content,
  })
}

describe('persistToSessionStore — image attachment reference', () => {
  it('writes a FilePart and a reference TextPart for images', async () => {
    const { stub, parts } = makeStub()
    await persist(stub, {
      type: 'file',
      url: 'http://localhost:3000/static/uploads/img-abc.png',
      filename: 'diagram.png',
      mimeType: 'image/png',
      size: 2048,
    })

    const fileParts = parts.filter((p) => p.type === 'file')
    const textParts = parts.filter((p) => p.type === 'text')
    expect(fileParts).toHaveLength(1)
    expect(textParts).toHaveLength(1)
    expect(textParts[0].text).toContain('User sent an image')
    expect(textParts[0].text).toContain('diagram.png')
    expect(textParts[0].text).toContain('http://localhost:3000/static/uploads/img-abc.png')
  })

  it('escapes markdown/breakout chars in the image filename', async () => {
    const { stub, parts } = makeStub()
    await persist(stub, {
      type: 'file',
      url: 'http://x/static/uploads/img-xyz.png',
      filename: 'di]agram(1).png',
      mimeType: 'image/png',
      size: 1024,
    })

    const ref = parts.find((p) => p.type === 'text')?.text as string
    expect(ref).toBeDefined()
    expect(ref).not.toContain('di]agram(1)')
    expect(ref).toContain('di_agram_1_.png')
  })

  it('keeps the caption TextPart and adds the reference (two text parts)', async () => {
    const { stub, parts } = makeStub()
    await persist(stub, {
      type: 'file',
      url: 'http://x/static/uploads/img-cap.png',
      filename: 'photo.png',
      mimeType: 'image/png',
      size: 512,
      caption: 'look at this',
    })

    const textParts = parts.filter((p) => p.type === 'text')
    expect(textParts).toHaveLength(2)
    expect(textParts.some((p) => p.text === 'look at this')).toBe(true)
    expect(textParts.some((p) => p.text.includes('User sent an image'))).toBe(true)
  })

  it('still emits an escaped reference for non-image files', async () => {
    const { stub, parts } = makeStub()
    await persist(stub, {
      type: 'file',
      url: 'http://x/static/uploads/doc-1.pdf',
      filename: 'report(final).pdf',
      mimeType: 'application/pdf',
      size: 4096,
    })

    const ref = parts.find((p) => p.type === 'text')?.text as string
    expect(ref).toContain('User sent a file')
    expect(ref).toContain('report_final_.pdf')
    expect(ref).not.toContain('report(final)')
  })
})
