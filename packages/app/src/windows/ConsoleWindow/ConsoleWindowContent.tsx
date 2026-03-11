/**
 * Console Window - Muestra logs de console en tiempo real
 */

import { Trash2 } from '@tamagui/lucide-icons';
import React, { useEffect, useRef, useState } from 'react';
import { ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { consoleCapture, type LogEntry } from './consoleCapture';

interface Props {
  windowId: string;
}

const LEVEL_COLORS: Record<string, string> = {
  log: '#888',
  info: '#06B6D4',
  warn: '#F59E0B',
  error: '#EF4444',
  debug: '#8B5CF6',
};

function formatArg(arg: any): string {
  if (arg === null) return 'null';
  if (arg === undefined) return 'undefined';
  if (typeof arg === 'string') return arg;
  if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg);
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;

  try {
    return JSON.stringify(arg, null, 2);
  } catch {
    return String(arg);
  }
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
}

export function ConsoleWindowContent({ windowId }: Props) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const scrollRef = useRef<ScrollView>(null);
  const autoScrollRef = useRef(true);

  useEffect(() => {
    // Install capture if not already installed
    consoleCapture.install();

    // Cargar logs existentes
    setLogs(consoleCapture.getLogs());

    // Suscribirse a nuevos logs
    const unsubscribe = consoleCapture.subscribe((entry) => {
      setLogs((prev) => [...prev, entry]);
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    // Auto-scroll al final cuando hay nuevos logs
    if (autoScrollRef.current && scrollRef.current) {
      setTimeout(() => {
        scrollRef.current?.scrollToEnd({ animated: false });
      }, 50);
    }
  }, [logs.length]);

  const handleClear = () => {
    consoleCapture.clear();
    setLogs([]);
  };

  return (
    <YStack flex={1}>
      {/* Toolbar */}
      <XStack
        height={32}
        paddingHorizontal={8}
        alignItems="center"
        borderBottomWidth={1}
        borderBottomColor="#1a1a1a"
        gap={8}
      >
        <Text color="#666" fontSize={11} fontFamily="$mono">
          {logs.length} logs
        </Text>

        <XStack flex={1} />

        <XStack
          padding={4}
          borderRadius={4}
          hoverStyle={{ backgroundColor: '#1a1a1a' }}
          cursor="pointer"
          onPress={handleClear}
        >
          <Trash2 size={14} color="#666" />
        </XStack>
      </XStack>

      {/* Logs */}
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        onScroll={(e) => {
          const { layoutMeasurement, contentOffset, contentSize } = e.nativeEvent;
          const isAtBottom = layoutMeasurement.height + contentOffset.y >= contentSize.height - 50;
          autoScrollRef.current = isAtBottom;
        }}
        scrollEventThrottle={100}
      >
        <YStack padding={8} gap={2}>
          {logs.map((entry) => (
            <XStack
              key={entry.id}
              gap={8}
              paddingVertical={2}
              paddingHorizontal={4}
              borderRadius={2}
              hoverStyle={{ backgroundColor: '#111' }}
            >
              <Text color="#444" fontSize={10} fontFamily="$mono" width={85} flexShrink={0}>
                {formatTime(entry.timestamp)}
              </Text>

              <Text
                color={LEVEL_COLORS[entry.level]}
                fontSize={10}
                fontFamily="$mono"
                width={40}
                flexShrink={0}
                textTransform="uppercase"
              >
                {entry.level}
              </Text>

              <Text color="#ccc" fontSize={11} fontFamily="$mono" flex={1} selectable>
                {entry.args.map(formatArg).join(' ')}
              </Text>
            </XStack>
          ))}

          {logs.length === 0 && (
            <Text color="#444" fontSize={11} textAlign="center" padding={20}>
              No logs yet
            </Text>
          )}
        </YStack>
      </ScrollView>
    </YStack>
  );
}
