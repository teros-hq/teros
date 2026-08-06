import { Square } from '@tamagui/lucide-icons';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import type { GestureResponderEvent } from 'react-native';
import { Button } from 'tamagui'
import { useColors } from '../mca/primitives/useColors'
import { colors as semanticColors } from '../mca/primitives/colors';
import { t } from '../../lib/i18n';
import { HardCancelModal } from './HardCancelModal';

const LONG_PRESS_MS = 500;

// Red tints used by the stop button. Kept semantic (theme-agnostic) because red
// is a safety signal; the surface behind the button is provided by the chat
// input container, so no theme-adaptive tokens are needed here.
const stopRed = {
  border: 'rgba(239, 68, 68, 0.25)',
  hoverBg: 'rgba(239, 68, 68, 0.12)',
  pressBg: 'rgba(239, 68, 68, 0.20)',
  pulseRest: 'rgba(239, 68, 68, 0.10)',
  pulsePeak: 'rgba(239, 68, 68, 0.18)',
} as const;

interface StopButtonProps {
  onSoftStop: () => void | Promise<void>;
  onHardStop: () => void | Promise<void>;
  hasIrreversibleToolInFlight?: boolean;
  irreversibleToolName?: string;
}

export function StopButton({
  onSoftStop,
  onHardStop,
  hasIrreversibleToolInFlight = false,
  irreversibleToolName,
}: StopButtonProps): React.ReactElement {
  const [modalOpen, setModalOpen] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);

  // Hook kept for future theme-adaptive work even though this component only
  // needs semantic red tints today.
  const _c = useColors();

  const clearTimer = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const handlePressIn = useCallback(() => {
    longPressFired.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      setModalOpen(true);
    }, LONG_PRESS_MS);
  }, []);

  const handlePressOut = useCallback(() => {
    clearTimer();
  }, [clearTimer]);

  const handlePress = useCallback(
    (e: GestureResponderEvent) => {
      clearTimer();
      const native = (e as { nativeEvent?: { shiftKey?: boolean } }).nativeEvent;
      const shiftKey = native?.shiftKey ?? false;
      if (longPressFired.current || shiftKey) {
        if (shiftKey && !modalOpen) setModalOpen(true);
        return;
      }
      void onSoftStop();
    },
    [clearTimer, modalOpen, onSoftStop],
  );

  const handleHardConfirm = useCallback(async () => {
    setModalOpen(false);
    await onHardStop();
  }, [onHardStop]);

  const handleKeyDown = useCallback(
    (e: { shiftKey?: boolean; key?: string; preventDefault?: () => void }) => {
      if (e.shiftKey && e.key === 'Enter') {
        e.preventDefault?.();
        setModalOpen(true);
      }
    },
    [],
  );

  const pulseCss = useMemo(
    () => `
      @keyframes stopPulse {
        0%, 100% { box-shadow: 0 0 0 0 ${stopRed.pulseRest}; }
        50% { box-shadow: 0 0 0 4px ${stopRed.pulsePeak}; }
      }
      .stop-btn-pulse {
        animation: stopPulse 2.5s ease-in-out infinite;
      }
    `,
    [],
  );

  return (
    <>
      <div
        className="stop-btn-pulse"
        style={{ display: 'inline-flex', borderRadius: 12, lineHeight: 0 }}
      >
        <style>{pulseCss}</style>
        <Button
          width={42}
          height={42}
          padding={0}
          borderRadius={12}
          backgroundColor="transparent"
          borderWidth={1}
          borderColor={stopRed.border}
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
          onPress={handlePress}
          hoverStyle={{
            backgroundColor: stopRed.hoverBg,
          }}
          pressStyle={{
            backgroundColor: stopRed.pressBg,
            scale: 0.95,
          }}
          // RN-Web zeroes `outline` by default, hiding Tab focus from keyboard users.
          focusStyle={{
            outlineWidth: 2,
            outlineColor: semanticColors.indigo,
            outlineStyle: 'solid',
            outlineOffset: 2,
          }}
          icon={<Square size={18} color={semanticColors.red} fill="none" strokeWidth={2} />}
          aria-label={t('chat.stop.ariaLabel')}
          aria-describedby="stop-btn-hint"
          accessibilityRole="button"
          // `onKeyDown` lands on the underlying DOM element via RN-Web prop forwarding; spread to bypass the RN type surface.
          {...({ onKeyDown: handleKeyDown } as { onKeyDown: typeof handleKeyDown })}
        />
      </div>
      {/* Offscreen (not display:none) so screen readers pick it up via aria-describedby. */}
      <Button
        unstyled
        id="stop-btn-hint"
        position="absolute"
        width={1}
        height={1}
        overflow="hidden"
        opacity={0}
        pointerEvents="none"
      >
        {t('chat.stop.hardHint')}
      </Button>
      <HardCancelModal
        open={modalOpen}
        hasIrreversibleToolInFlight={hasIrreversibleToolInFlight}
        irreversibleToolName={irreversibleToolName}
        onConfirm={handleHardConfirm}
        onCancel={() => setModalOpen(false)}
      />
    </>
  );
}
