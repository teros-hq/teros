import { describe, expect, it } from 'vitest'
import { renderWithTamagui } from '../../../test/renderWithTamagui'
import { VoiceBubble, formatDuration } from './VoiceBubble'

/**
 * TER-461 — VoiceBubble: función pura `formatDuration` + render de la transcripción.
 * El render evita i18n testeando el branch de `transcription` (texto crudo, sin `t()`).
 */
describe('formatDuration', () => {
  it('formatea m:ss con cero-padding de segundos', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(5)).toBe('0:05') // padStart(2,'0')
    expect(formatDuration(59)).toBe('0:59')
    expect(formatDuration(60)).toBe('1:00') // rollover exacto del minuto
    expect(formatDuration(65)).toBe('1:05')
    expect(formatDuration(125)).toBe('2:05')
    expect(formatDuration(600)).toBe('10:00') // minutos de dos dígitos
  })

  it('trunca la fracción de segundo (Math.floor)', () => {
    expect(formatDuration(65.9)).toBe('1:05')
  })
})

describe('VoiceBubble — render', () => {
  it('muestra la transcripción del mensaje de voz', () => {
    const { getByText } = renderWithTamagui(
      <VoiceBubble
        url="blob:x"
        transcription="hola mundo"
        timestamp={new Date(0)}
        showTimestamp={false}
      />,
    )
    expect(getByText(/hola mundo/)).toBeTruthy()
  })

  it('prioriza la transcripción sobre el error de transcripción (orden de los ternarios)', () => {
    // Con `transcription` y `transcriptionError` presentes a la vez, el ternario
    // elige la transcripción. Si se invierte el orden, se pinta el error y la
    // transcripción desaparece → getByText falla. La aserción positiva muerde.
    const { getByText } = renderWithTamagui(
      <VoiceBubble
        url="blob:x"
        transcription="transcripcion ganadora"
        transcriptionError="fallo de transcripcion"
        timestamp={new Date(0)}
        showTimestamp={false}
      />,
    )
    expect(getByText(/transcripcion ganadora/)).toBeTruthy()
  })
})
