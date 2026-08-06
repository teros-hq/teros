import React from 'react'
import { Platform, Pressable, Text, View } from 'react-native'
import { captureException } from '../lib/sentry'
import { surface } from './mca/primitives/colors'

/**
 * Root error boundary (TER-418).
 *
 * Los errores de render de React NO los captura `window.onerror` ni la
 * instrumentación de Sentry: sin un ErrorBoundary, un throw en cualquier ruta
 * desmonta TODO el árbol y el usuario ve una pantalla en blanco sin que Sentry
 * reciba nada. Este boundary envuelve la app entera y, al fallar, reporta el
 * error a Sentry (con el component stack para reproducirlo) y muestra un fallback
 * accionable en lugar de la pantalla blanca.
 *
 * El fallback usa React Native plano (no Tamagui): así sigue funcionando aunque
 * lo que haya fallado sea un provider del árbol (Tamagui, i18n, toast).
 */

interface Props {
  children: React.ReactNode
}

interface State {
  hasError: boolean
}

export class RootErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    captureException(error, { componentStack: errorInfo.componentStack })
    console.error('[RootErrorBoundary] Uncaught render error:', error, errorInfo)
  }

  private handleReload = (): void => {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.location.reload()
      return
    }
    // En nativo no hay reload de página: limpiar el estado para reintentar el render.
    this.setState({ hasError: false })
  }

  render(): React.ReactNode {
    if (!this.state.hasError) {
      return this.props.children
    }
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          backgroundColor: surface.dark.bgPage,
        }}
      >
        <Text
          style={{
            color: surface.dark.text,
            fontSize: 18,
            fontWeight: '600',
            marginBottom: 8,
            textAlign: 'center',
          }}
        >
          Algo ha fallado
        </Text>
        <Text style={{ color: surface.dark.text2, fontSize: 14, marginBottom: 24, textAlign: 'center' }}>
          La aplicación encontró un error inesperado. El equipo ha sido notificado.
        </Text>
        <Pressable
          onPress={this.handleReload}
          accessibilityRole="button"
          accessibilityLabel="Recargar la aplicación"
          style={{
            backgroundColor: surface.dark.text,
            paddingVertical: 12,
            paddingHorizontal: 24,
            borderRadius: 8,
          }}
        >
          <Text style={{ color: surface.dark.bgPage, fontSize: 15, fontWeight: '600' }}>Recargar</Text>
        </Pressable>
      </View>
    )
  }
}
