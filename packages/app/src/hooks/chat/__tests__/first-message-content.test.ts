/**
 * Tests for `buildFirstMessageContent` — the content of the first message of a new
 * chat (channel.create-with-message).
 *
 * Regression: the original inline logic only handled audio/text and dropped image
 * (and other file) attachments, so starting a conversation with an image left the
 * agent with no image to see. These tests pin the file-inclusion behavior.
 */

import { describe, expect, it } from 'bun:test'
import { buildFirstMessageContent, type UploadedFileLite } from '../first-message-content'

const img: UploadedFileLite = {
  url: 'http://localhost:10001/static/uploads/pic-abc.png',
  originalName: 'pic.png',
  mimeType: 'image/png',
  size: 1234,
}
const img2: UploadedFileLite = {
  url: 'http://localhost:10001/static/uploads/pic2-def.png',
  originalName: 'pic2.png',
  mimeType: 'image/png',
  size: 5678,
}
const pdf: UploadedFileLite = {
  url: 'http://localhost:10001/static/uploads/doc-xyz.pdf',
  originalName: 'doc.pdf',
  mimeType: 'application/pdf',
  size: 9999,
}

describe('buildFirstMessageContent', () => {
  it('returns text content when there are no files or audio', () => {
    expect(buildFirstMessageContent({ text: 'hola' })).toEqual({ type: 'text', text: 'hola' })
  })

  it('returns the image as file content (regression: image must not be dropped)', () => {
    const c = buildFirstMessageContent({ files: [img], text: '' })
    expect(c.type).toBe('file')
    expect(c.url).toBe(img.url)
    expect(c.filename).toBe('pic.png')
    expect(c.mimeType).toBe('image/png')
    expect(c.size).toBe(1234)
  })

  it('merges trailing text as caption for a single file (image + question, one turn)', () => {
    const c = buildFirstMessageContent({ files: [img], text: '¿Qué ves aquí?' })
    expect(c.type).toBe('file')
    expect(c.caption).toBe('¿Qué ves aquí?')
  })

  it('omits caption when there is no text', () => {
    const c = buildFirstMessageContent({ files: [img], text: '' })
    expect(c.caption).toBeUndefined()
  })

  it('does NOT attach caption with multiple files (text sent separately by caller)', () => {
    const c = buildFirstMessageContent({ files: [img, img2], text: 'mira estas' })
    expect(c.type).toBe('file')
    expect(c.url).toBe(img.url) // first file only
    expect(c.caption).toBeUndefined()
  })

  it('works for non-image files too', () => {
    const c = buildFirstMessageContent({ files: [pdf], text: '' })
    expect(c.type).toBe('file')
    expect(c.filename).toBe('doc.pdf')
    expect(c.mimeType).toBe('application/pdf')
  })

  it('prefers audio over files and text', () => {
    const c = buildFirstMessageContent({
      audio: { data: 'base64audio', mimeType: 'audio/webm', duration: 3 },
      files: [img],
      text: 'ignored',
    })
    expect(c.type).toBe('voice')
    expect(c.data).toBe('base64audio')
    expect(c.duration).toBe(3)
  })
})
