/**
 * WindowContent - Renders the content of a window according to its type
 */

import { AlertCircle } from '@tamagui/lucide-icons';
import React, { Suspense } from 'react';
import { Text, YStack } from 'tamagui';
import { windowRegistry } from '../../services/windowRegistry';
import { FullscreenLoader } from '../../components/ui';

interface WindowLike {
  id: string;
  type: string;
  props: Record<string, any>;
  [key: string]: any;
}

interface Props {
  window: WindowLike;
}

/**
 * Renders the correct component based on the window type.
 *
 * The resetKey combines id + type so the ErrorBoundary resets
 * both when switching tabs (same id, different content does not apply here)
 * and when doing replaceWindow (same id, different type/props).
 */
export function WindowContent({ window }: Props) {
  const definition = windowRegistry.get(window.type);

  if (!definition) {
    return <WindowError message={`Unknown window type: ${window.type}`} />;
  }

  const Component = definition.component;
  // resetKey changes when the actual window content changes,
  // forzando al ErrorBoundary a limpiar su estado de error.
  const resetKey = `${window.id}::${window.type}`;

  return (
    <ErrorBoundary
      resetKey={resetKey}
      fallback={(error) => <WindowError message="Error loading window content" error={error} />}
    >
      <Suspense fallback={<WindowLoading />}>
        <Component {...window.props} windowId={window.id} />
      </Suspense>
    </ErrorBoundary>
  );
}

/**
 * Loading state
 */
function WindowLoading() {
  return (
    <FullscreenLoader />
  );
}

/**
 * Error state
 */
function WindowError({ message, error }: { message: string; error?: Error }) {
  return (
    <YStack
      flex={1}
      justifyContent="center"
      alignItems="center"
      padding="$4"
      backgroundColor="$background"
      gap="$3"
    >
      <AlertCircle size={32} color="$red10" />
      <Text color="$red10" textAlign="center">
        {message}
      </Text>
      {error && (
        <Text color="$gray10" fontSize="$2" textAlign="center" opacity={0.7}>
          {error.message}
        </Text>
      )}
    </YStack>
  );
}

/**
 * Error Boundary con soporte de reset por clave.
 *
 * When `resetKey` changes (e.g. when the window type or id changes),
 * the error state is automatically cleared so the new content
 * does not inherit the error from the previous content.
 */
interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback: (error?: Error) => React.ReactNode;
  /** When this key changes, the error is automatically reset */
  resetKey?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error?: Error;
  /** Clave en el momento en que se produjo el error */
  errorResetKey?: string;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState,
  ): Partial<ErrorBoundaryState> | null {
    // If there's an active error AND the key has changed since the error occurred,
    // reset the state so the new content renders cleanly.
    if (state.hasError && props.resetKey !== state.errorResetKey) {
      return { hasError: false, error: undefined, errorResetKey: undefined };
    }
    return null;
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[WindowContent] Error caught:', error, errorInfo);
    // Save the resetKey at the time of the error to detect changes later
    this.setState({ errorResetKey: this.props.resetKey });
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback(this.state.error);
    }
    return this.props.children;
  }
}
