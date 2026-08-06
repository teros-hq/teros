import { AlertCircle, AlertTriangle, CheckCircle, Info } from '@tamagui/lucide-icons';
import {
  Toast,
  ToastProvider,
  ToastViewport,
  useToastController,
  useToastState,
} from '@tamagui/toast';
import type React from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { XStack, YStack } from 'tamagui';
import { badges, colors, surface } from './mca/primitives/colors';

// Toast types for different styling
export type ToastType = 'info' | 'success' | 'warning' | 'error';

// Extend CustomData for type safety
declare module '@tamagui/toast' {
  interface CustomData {
    type?: ToastType;
  }
}

// Toast styling based on type
const toastStyles: Record<ToastType, { bg: string; border: string; icon: React.ReactNode }> = {
  info: {
    bg: badges.dark.info.bg,
    border: badges.dark.info.border,
    icon: <Info size={18} color={colors.indigo} />,
  },
  success: {
    bg: badges.dark.ok.bg,
    border: badges.dark.ok.border,
    icon: <CheckCircle size={18} color={colors.green} />,
  },
  warning: {
    bg: badges.dark.warn.bg,
    border: badges.dark.warn.border,
    icon: <AlertTriangle size={18} color={colors.amber} />,
  },
  error: {
    bg: badges.dark.err.bg,
    border: badges.dark.err.border,
    icon: <AlertCircle size={18} color={colors.red} />,
  },
};

// Current toast renderer
function CurrentToast() {
  const toast = useToastState();

  if (!toast || toast.isHandledNatively) {
    return null;
  }

  const type = (toast.customData?.type as ToastType) || 'info';
  const styles = toastStyles[type];

  return (
    <Toast
      key={toast.id}
      testID={`toast-${type}`}
      duration={toast.duration}
      enterStyle={{ opacity: 0, scale: 0.95, y: -10 }}
      exitStyle={{ opacity: 0, scale: 0.95, y: -10 }}
      opacity={1}
      scale={1}
      y={0}
      animation="quick"
      backgroundColor={styles.bg}
      borderWidth={1}
      borderColor={styles.border}
      borderRadius="$3"
      paddingHorizontal="$4"
      paddingVertical="$3"
      marginHorizontal="$4"
    >
      <XStack gap="$3" alignItems="center">
        {styles.icon}
        <YStack flex={1}>
          {toast.title && (
            <Toast.Title color={surface.dark.text} fontSize="$3" fontWeight="600">
              {toast.title}
            </Toast.Title>
          )}
          {toast.message && (
            <Toast.Description color={surface.dark.text2} fontSize="$2">
              {toast.message}
            </Toast.Description>
          )}
        </YStack>
      </XStack>
    </Toast>
  );
}

// Safe viewport that respects safe areas
function SafeToastViewport() {
  const insets = useSafeAreaInsets();

  return (
    <ToastViewport
      flexDirection="column-reverse"
      top={insets.top + 10}
      left={0}
      right={0}
      alignItems="center"
    />
  );
}

// Provider wrapper
export function TerosToastProvider({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider swipeDirection="up" duration={3000}>
      {children}
      <CurrentToast />
      <SafeToastViewport />
    </ToastProvider>
  );
}

// Hook for showing toasts
export function useToast() {
  const toast = useToastController();

  return {
    show: (title: string, options?: { message?: string; type?: ToastType; duration?: number }) => {
      toast.show(title, {
        message: options?.message,
        duration: options?.duration,
        customData: { type: options?.type || 'info' },
      });
    },
    info: (title: string, message?: string) => {
      toast.show(title, { message, customData: { type: 'info' } });
    },
    success: (title: string, message?: string) => {
      toast.show(title, { message, customData: { type: 'success' } });
    },
    warning: (title: string, message?: string) => {
      toast.show(title, { message, customData: { type: 'warning' } });
    },
    error: (title: string, message?: string) => {
      toast.show(title, { message, customData: { type: 'error' } });
    },
    hide: () => toast.hide(),
  };
}
