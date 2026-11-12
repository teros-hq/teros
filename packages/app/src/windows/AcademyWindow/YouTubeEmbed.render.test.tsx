import { describe, expect, it } from 'vitest'
import { renderWithTamagui } from '../../test/renderWithTamagui'
import { YouTubeEmbed } from './YouTubeEmbed'

describe('YouTubeEmbed (web)', () => {
  it('renders a youtube-nocookie iframe for the given id', () => {
    const { container } = renderWithTamagui(<YouTubeEmbed youtubeId="abcdefghijk" title="Demo" />)
    const iframe = container.querySelector('iframe')
    expect(iframe).toBeTruthy()
    expect(iframe?.getAttribute('src')).toBe('https://www.youtube-nocookie.com/embed/abcdefghijk')
    expect(iframe?.getAttribute('title')).toBe('Demo')
  })
})
