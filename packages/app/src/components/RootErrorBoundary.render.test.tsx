import { render } from '@testing-library/react'
import { Text } from 'react-native'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { captureException } from '../lib/sentry'
import { RootErrorBoundary } from './RootErrorBoundary'

/**
 * TER-418: un crash de render de React (un throw en cualquier ruta) desmonta TODO
 * el árbol y el usuario ve una pantalla en blanco — y Sentry no recibe nada,
 * porque los errores de render NO los captura window.onerror. El RootErrorBoundary
 * debe (a) mostrar un fallback accionable en vez de la pantalla blanca y (b)
 * reportar el error a Sentry. Esto solo se ve renderizando de verdad (harness #131).
 */
vi.mock('../lib/sentry', () => ({ captureException: vi.fn() }))

function Boom(): never {
  throw new Error('render boom')
}

describe('RootErrorBoundary (render)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('muestra el fallback y reporta a Sentry cuando un hijo lanza en render', () => {
    // React vuelca el error capturado a console.error; silenciar ese ruido.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { getByText, getByLabelText } = render(
      <RootErrorBoundary>
        <Boom />
      </RootErrorBoundary>,
    )

    // (a) fallback accionable visible
    expect(getByText('Algo ha fallado')).toBeTruthy()
    expect(getByLabelText('Recargar la aplicación')).toBeTruthy()

    // (b) reportado a Sentry con el error real (no un placeholder)
    expect(captureException).toHaveBeenCalledTimes(1)
    const [reportedError] = vi.mocked(captureException).mock.calls[0]
    expect(reportedError).toBeInstanceOf(Error)
    expect((reportedError as Error).message).toBe('render boom')

    consoleSpy.mockRestore()
  })

  it('renderiza los hijos y NO reporta cuando no hay error', () => {
    const { getByText, queryByText } = render(
      <RootErrorBoundary>
        <Text>contenido OK</Text>
      </RootErrorBoundary>,
    )

    expect(getByText('contenido OK')).toBeTruthy()
    expect(queryByText('Algo ha fallado')).toBeNull()
    expect(captureException).not.toHaveBeenCalled()
  })
})
