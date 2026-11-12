import { describe, expect, it } from 'vitest'
import {
  getRenderKind,
  isInlineRenderable,
  rendersAsFallbackRow,
  kindIcon,
  kindLabel,
  formatFileSize,
  shareFileType,
  WATCHABLE_KINDS,
  INLINE_MAX_BYTES,
} from './fileRenderers'

/** FVU — the single render table (spec FVU-REQ-3): every type maps to a kind,
 *  unknown types fall back, and the mapping never throws. */
describe('fileRenderers — getRenderKind', () => {
  it('maps every supported extension to its render kind', () => {
    expect(getRenderKind('informe.md')).toBe('markdown')
    expect(getRenderKind('notes.markdown')).toBe('markdown')
    expect(getRenderKind('diagrama.png')).toBe('image')
    expect(getRenderKind('foto.jpg')).toBe('image')
    expect(getRenderKind('contrato.pdf')).toBe('pdf')
    expect(getRenderKind('demo.mp4')).toBe('video')
    expect(getRenderKind('song.mp3')).toBe('audio')
    expect(getRenderKind('datos.csv')).toBe('csv')
    expect(getRenderKind('config.json')).toBe('json')
    expect(getRenderKind('notas.txt')).toBe('text')
    expect(getRenderKind('mockup.html')).toBe('html')
  })

  it('unknown extensions fall back — the render never fails by type (FVU-REQ-5)', () => {
    expect(getRenderKind('backup.zip')).toBe('fallback')
    expect(getRenderKind('doc.docx')).toBe('fallback')
    expect(getRenderKind('noext')).toBe('fallback')
  })

  it('mimeType is the fallback path when the extension is unknown', () => {
    expect(getRenderKind('file', 'image/png')).toBe('image')
    expect(getRenderKind('file', 'application/pdf')).toBe('pdf')
    expect(getRenderKind('file', 'audio/mpeg')).toBe('audio')
    expect(getRenderKind('file', 'video/mp4')).toBe('video')
    expect(getRenderKind('file', 'application/zip')).toBe('fallback')
  })

  it('extension wins over mimeType (the agent controls the filename)', () => {
    expect(getRenderKind('report.md', 'text/plain')).toBe('markdown')
  })
})

describe('fileRenderers — inline guard', () => {
  it('fallback kinds are never inline', () => {
    expect(isInlineRenderable('fallback')).toBe(false)
  })

  it('oversized files never go inline (spec edge case >10MB)', () => {
    expect(isInlineRenderable('image', INLINE_MAX_BYTES + 1)).toBe(false)
    expect(isInlineRenderable('image', INLINE_MAX_BYTES)).toBe(true)
    expect(isInlineRenderable('markdown', 1024)).toBe(true)
  })
})

describe('fileRenderers — rendersAsFallbackRow (v1.3.6 strip/fallback single source of truth)', () => {
  it('fallback kinds render as the fallback row (zip: no strip ever)', () => {
    expect(rendersAsFallbackRow('fallback')).toBe(true)
  })

  it('v1.3.9: pdf NEVER renders as the fallback row — Pablo verified the iPhone iframe works (the old blank embed was the XFO bug, fixed v1.3.7)', () => {
    expect(rendersAsFallbackRow('pdf')).toBe(false)
  })

  it('inline kinds (md/csv/json/txt/html/image/audio/video) NEVER render as the fallback row', () => {
    for (const kind of ['markdown', 'csv', 'json', 'text', 'html', 'image', 'audio', 'video'] as const) {
      expect(rendersAsFallbackRow(kind)).toBe(false)
      expect(rendersAsFallbackRow(kind)).toBe(false)
    }
  })
})

describe('fileRenderers — helpers', () => {
  it('kindIcon/kindLabel return per-kind icon and label', () => {
    expect(kindIcon('markdown')).toBe('file-md')
    expect(kindIcon('fallback')).toBe('file')
    expect(kindLabel('pdf', 'x.pdf')).toBe('PDF')
    expect(kindLabel('fallback', 'backup.zip')).toBe('ZIP')
    expect(kindLabel('fallback', 'noext')).toBe('FILE')
  })

  it('formatFileSize formats B / KB / MB', () => {
    expect(formatFileSize(undefined)).toBe('')
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(2048)).toBe('2.0 KB')
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB')
  })

  it('shareFileType maps kinds to the backend contract', () => {
    expect(shareFileType('html')).toBe('html')
    expect(shareFileType('markdown')).toBe('markdown')
    expect(shareFileType('pdf')).toBe('file')
    expect(shareFileType('image')).toBe('file')
  })

  it('WATCHABLE_KINDS contains exactly the text kinds (FVU-REQ-4)', () => {
    expect(WATCHABLE_KINDS.has('markdown')).toBe(true)
    expect(WATCHABLE_KINDS.has('csv')).toBe(true)
    expect(WATCHABLE_KINDS.has('json')).toBe(true)
    expect(WATCHABLE_KINDS.has('text')).toBe(true)
    expect(WATCHABLE_KINDS.has('html')).toBe(true)
    expect(WATCHABLE_KINDS.has('image')).toBe(false)
    expect(WATCHABLE_KINDS.has('pdf')).toBe(false)
    expect(WATCHABLE_KINDS.has('audio')).toBe(false)
    expect(WATCHABLE_KINDS.has('video')).toBe(false)
  })
})
