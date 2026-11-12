import { describe, expect, it } from 'vitest'
import {
  ACADEMY_PHASES,
  ACADEMY_VIDEOS,
  getVideosByPhase,
  filterVideos,
  getAdjacentVideos,
  localize,
  localizeSteps,
  resolveContentLang,
  youtubeEmbedUrl,
  youtubeThumbnailUrl,
} from './academyCatalog'

describe('academyCatalog', () => {
  it('defines the 9 phases in order 1..9 with unique ids', () => {
    expect(ACADEMY_PHASES).toHaveLength(9)
    expect(ACADEMY_PHASES.map((p) => p.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(new Set(ACADEMY_PHASES.map((p) => p.id)).size).toBe(9)
  })

  it('every video references a known phase, has an 11-char youtubeId and bilingual content', () => {
    const ids = new Set(ACADEMY_PHASES.map((p) => p.id))
    for (const v of ACADEMY_VIDEOS) {
      expect(ids.has(v.phase)).toBe(true)
      expect(v.youtubeId).toHaveLength(11)
      expect(v.objective.en.length).toBeGreaterThan(0)
      expect(v.objective.es.length).toBeGreaterThan(0)
      expect(v.transcript.en.length).toBeGreaterThan(0)
      expect(v.transcript.es.length).toBeGreaterThan(0)
      expect(v.steps.en.length).toBeGreaterThan(0)
      expect(v.steps.es.length).toBeGreaterThan(0)
    }
  })

  it('video ids are unique', () => {
    expect(new Set(ACADEMY_VIDEOS.map((v) => v.id)).size).toBe(ACADEMY_VIDEOS.length)
  })

  it('getVideosByPhase returns that phase sorted by number', () => {
    const vids = getVideosByPhase('phase1')
    expect(vids.length).toBeGreaterThan(0)
    expect(vids.every((v) => v.phase === 'phase1')).toBe(true)
    const numbers = vids.map((v) => v.number)
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b))
  })

  it('filterVideos matches objective in either language, case-insensitively', () => {
    const sample = ACADEMY_VIDEOS[0]
    const termEn = sample.objective.en.slice(0, 5).toUpperCase()
    const termEs = sample.objective.es.slice(0, 5).toUpperCase()
    expect(filterVideos('all', termEn).some((v) => v.id === sample.id)).toBe(true)
    expect(filterVideos('all', termEs).some((v) => v.id === sample.id)).toBe(true)
  })

  it('filterVideos restricts to a single phase', () => {
    const hits = filterVideos('phase2', '')
    expect(hits.every((v) => v.phase === 'phase2')).toBe(true)
  })

  it('getAdjacentVideos walks within the same phase by number', () => {
    const [first, second] = getVideosByPhase('phase1')
    expect(getAdjacentVideos(first.id).prev).toBeNull()
    expect(getAdjacentVideos(first.id).next?.id).toBe(second.id)
    expect(getAdjacentVideos(second.id).prev?.id).toBe(first.id)
  })

  it('localize / localizeSteps pick the right language', () => {
    expect(localize({ en: 'Hello', es: 'Hola' }, 'en')).toBe('Hello')
    expect(localize({ en: 'Hello', es: 'Hola' }, 'es')).toBe('Hola')
    expect(localizeSteps({ en: ['a'], es: ['b'] }, 'es')).toEqual(['b'])
  })

  it('resolveContentLang maps UI language to content language', () => {
    expect(resolveContentLang('en-US')).toBe('en')
    expect(resolveContentLang('en')).toBe('en')
    expect(resolveContentLang('es-ES')).toBe('es')
    expect(resolveContentLang('ko-KR')).toBe('es')
  })

  it('builds embed and thumbnail urls from the id', () => {
    expect(youtubeEmbedUrl('abcdefghijk')).toBe('https://www.youtube-nocookie.com/embed/abcdefghijk')
    expect(youtubeThumbnailUrl('abcdefghijk')).toBe('https://img.youtube.com/vi/abcdefghijk/hqdefault.jpg')
  })
})
