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
    bg: 'rgba(6, 182, 212, 0.15)',
    border: 'rgba(6, 182, 212, 0.3)',
    icon: <Info size={18} color="#06B6D4" />,
  },
  success: {
    bg: 'rgba(34, 197, 94, 0.15)',
    border: 'rgba(34, 197, 94, 0.3)',
    icon: <CheckCircle size={18} color="#22C55E" />,
  },
  warning: {
    bg: 'rgba(245, 158, 11, 0.15)',
    border: 'rgba(245, 158, 11, 0.3)',
    icon: <AlertTriangle size={18} color="#F59E0B" />,
  },
  error: {
    bg: 'rgba(239, 68, 68, 0.15)',
    border: 'rgba(239, 68, 68, 0.3)',
    icon: <AlertCircle size={18} color="#EF4444" />,
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
            <Toast.Title color="#E4E4E7" fontSize="$3" fontWeight="600">
              {toast.title}
            </Toast.Title>
          )}
          {toast.message && (
            <Toast.Description color="#A1A1AA" fontSize="$2">
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
