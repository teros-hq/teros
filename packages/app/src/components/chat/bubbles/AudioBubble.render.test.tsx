import { describe, expect, it } from 'vitest'
import { renderWithTamagui } from '../../../test/renderWithTamagui'
import { AudioBubble } from './AudioBubble'

/**
 * TER-461 — AudioBubble: caption, frontera de la duración mostrada y estado de error.
 * Sin i18n (los textos de estado son literales). `formatDuration` se cubre en
 * VoiceBubble.render.test.tsx; aquí afirmamos solo lo propio de AudioBubble.
 */
describe('AudioBubble — render', () => {
  it('muestra el caption del audio', () => {
    const { getByText } = renderWithTamagui(
      <AudioBubble url="blob:x" caption="podcast episodio 1" timestamp={new Date(0)} showTimestamp={false} />,
    )
    expect(getByText(/podcast episodio 1/)).toBeTruthy()
  })

  it('formatea la duración total cuando es > 0', () => {
    // displayDuration = audioDuration || duration || 0 → 125 → formatDuration(125) = '2:05'.
    const { getByText } = renderWithTamagui(
      <AudioBubble url="blob:x" duration={125} timestamp={new Date(0)} showTimestamp={false} />,
    )
    expect(getByText('2:05')).toBeTruthy()
  })

  it('muestra --:-- cuando no hay duración (frontera en 0)', () => {
    const { getByText } = renderWithTamagui(
      <AudioBubble url="blob:x" timestamp={new Date(0)} showTimestamp={false} />,
    )
    expect(getByText('--:--')).toBeTruthy()
  })

  it('muestra el aviso de error cuando el envío falla', () => {
    const { getByText } = renderWithTamagui(
      <AudioBubble url="blob:x" status="failed" timestamp={new Date(0)} showTimestamp={false} />,
    )
    expect(getByText(/Error al enviar/)).toBeTruthy()
  })
})
