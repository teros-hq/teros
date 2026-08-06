/**
 * BrowserbaseWindowContent
 *
 * Renders the Browserbase Live View in an iframe.
 * Shows the browser session in real time as the agent navigates.
 */

import { ExternalLink, MonitorPlay, RefreshCw } from '@tamagui/lucide-icons';
import React, { useState } from 'react';
import { Platform } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button, Text, XStack, YStack } from 'tamagui';
import { useColors } from '../../components/mca/primitives/useColors';
import { colors as semanticColors } from '../../components/mca/primitives/colors';
import type { BrowserbaseWindowProps } from './definition';

interface Props extends BrowserbaseWindowProps {
  windowId: string;
}

export function BrowserbaseWindowContent({
  sessionId,
  liveViewUrl,
  caption,
}: Props) {
  const { t } = useTranslation();
  const c = useColors();
  const [key, setKey] = useState(0);
  const [loaded, setLoaded] = useState(false);

  const shortId = sessionId.slice(0, 8);

  const handleRefresh = () => {
    setLoaded(false);
    setKey((k) => k + 1);
  };

  const handleOpenExternal = () => {
    if (Platform.OS === 'web') {
      window.open(liveViewUrl, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <YStack flex={1} backgroundColor={c.bgPage}>
      {/* ── Toolbar ── */}
      <XStack
        backgroundColor={c.bgCard}
        paddingHorizontal={12}
        paddingVertical={6}
        alignItems="center"
        gap={8}
        borderBottomWidth={1}
        borderBottomColor={c.border}
      >
        {/* Icon + label */}
        <MonitorPlay size={13} color={semanticColors.indigo} />

        <Text
          color={c.text2}
          fontSize={11}
          fontFamily="$mono"
        >
          {t('browserbase.session')}
        </Text>

        {/* Session ID badge */}
        <XStack
          backgroundColor={semanticColors.indigoGlow}
          paddingHorizontal={6}
          paddingVertical={2}
          borderRadius={4}
          borderWidth={1}
          borderColor={c.badges.info.border}
        >
          <Text color={c.badges.info.text} fontSize={10} fontFamily="$mono">
            {shortId}...
          </Text>
        </XStack>

        {/* Live indicator */}
        <XStack alignItems="center" gap={4}>
          <YStack
            width={6}
            height={6}
            borderRadius={3}
            backgroundColor={semanticColors.green}
            // @ts-ignore web-only
            style={
              Platform.OS === 'web'
                ? { animation: 'pulse 2s infinite' }
                : undefined
            }
          />
          <Text color={semanticColors.green} fontSize={10} fontWeight="600">
            {t('browserbase.live')}
          </Text>
        </XStack>

        {/* Caption */}
        {caption && (
          <Text
            color={c.text3}
            fontSize={10}
            flex={1}
            numberOfLines={1}
          >
            {caption}
          </Text>
        )}

        <XStack flex={1} />

        {/* Actions */}
        <Button
          size="$2"
          chromeless
          icon={<RefreshCw size={12} color={c.text3} />}
          onPress={handleRefresh}
          pressStyle={{ opacity: 0.6 }}
        />

        {Platform.OS === 'web' && (
          <Button
            size="$2"
            chromeless
            icon={<ExternalLink size={12} color={c.text3} />}
            onPress={handleOpenExternal}
            pressStyle={{ opacity: 0.6 }}
          />
        )}
      </XStack>

      {/* ── Live View iframe ── */}
      {Platform.OS === 'web' ? (
        <iframe
          key={key}
          src={liveViewUrl}
          onLoad={() => setLoaded(true)}
          style={{
            flex: 1,
            border: 'none',
            width: '100%',
            height: '100%',
            backgroundColor: '#ffffff',
            display: 'block',
          }}
          allow="clipboard-read; clipboard-write"
          title={t('browserbase.iframeTitle', { shortId })}
        />
      ) : (
        // React Native fallback — deep link to open externally
        <YStack flex={1} alignItems="center" justifyContent="center" gap={16} padding={24}>
          <MonitorPlay size={48} color={semanticColors.indigo} opacity={0.6} />
          <Text color={c.text2} fontSize={14} textAlign="center">
            {t('browserbase.webOnly')}
          </Text>
          <Text color={c.text3} fontSize={11} fontFamily="$mono" textAlign="center">
            {t('browserbase.sessionId', { sessionId })}
          </Text>
        </YStack>
      )}
    </YStack>
  );
}
