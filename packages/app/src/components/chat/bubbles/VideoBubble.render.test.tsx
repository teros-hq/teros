import { describe, expect, it } from 'vitest'
import { renderWithTamagui } from '../../../test/renderWithTamagui'
import { VideoBubble } from './VideoBubble'

/**
 * TER-461 — VideoBubble (rama web): monta un <video> nativo con src/poster/controles.
 * El harness corre como react-native-web (Platform.OS === 'web'), así que se ejercita
 * el reproductor inline real, no el fallback nativo.
 */
describe('VideoBubble — render (web)', () => {
  it('monta un <video> con src, poster y controles nativos', () => {
    const { container } = renderWithTamagui(
      <VideoBubble
        url="https://cdn.test/v.mp4"
        thumbnailUrl="https://cdn.test/p.jpg"
        timestamp={new Date(0)}
        showTimestamp={false}
      />,
    )
    const video = container.querySelector('video')
    expect(video).toBeTruthy()
    expect(video?.getAttribute('src')).toBe('https://cdn.test/v.mp4')
    expect(video?.getAttribute('poster')).toBe('https://cdn.test/p.jpg')
    expect(video?.hasAttribute('controls')).toBe(true)
  })

  it('muestra el caption del vídeo', () => {
    const { getByText } = renderWithTamagui(
      <VideoBubble
        url="https://cdn.test/v.mp4"
        caption="clip de demostracion"
        timestamp={new Date(0)}
        showTimestamp={false}
      />,
    )
    expect(getByText(/clip de demostracion/)).toBeTruthy()
  })
})
