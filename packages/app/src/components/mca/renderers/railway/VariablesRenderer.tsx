/**
 * Railway Renderer - Variables
 *
 * Handles: railway-list-variables, railway-set-variables
 */

import type React from 'react';
import { ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import type { ToolCallRendererProps } from '../../types';
import { ErrorBlock, SuccessBlock, ToolCallCard } from '../../primitives';
import {
  Badge,
  useRailwayColors,
  parseOutput,
  truncate,
} from './shared';

// ============================================================================
// Content Blocks
// ============================================================================

interface VariableRowProps {
  name: string;
  value: string;
  isMasked?: boolean;
}

function VariableRow({ name, value, isMasked }: VariableRowProps) {
  const c = useRailwayColors();
  const colors = useRailwayColors();
  return (
    <XStack
      alignItems="center"
      gap={8}
      paddingVertical={5}
      paddingHorizontal={8}
      hoverStyle={{ backgroundColor: c.bgCardHover }}
    >
      <Text color={colors.railwayRed} fontSize={9} fontFamily="$mono" width={120} numberOfLines={1}>
        {name}
      </Text>
      <Text
        flex={1}
        color={isMasked ? c.text3 : c.text2}
        fontSize={9}
        fontFamily="$mono"
        numberOfLines={1}
      >
        {value}
      </Text>
    </XStack>
  );
}

// Parse variables from markdown output
function parseVariablesFromMarkdown(
  text: string,
): Array<{ name: string; value: string; masked: boolean }> {
  const results: Array<{ name: string; value: string; masked: boolean }> = [];
  // Match lines like: - **KEY**: value
  const regex = /- \*\*([^*]+)\*\*:\s*(.+)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const value = match[2].trim();
    results.push({
      name: match[1],
      value,
      masked: value === '***',
    });
  }
  return results;
}

// ============================================================================
// Renderers
// ============================================================================

export function ListVariablesRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRailwayColors();
  const colors = useRailwayColors();

  const parsed = output ? parseOutput<string>(output) : null;
  const variables = typeof parsed === 'string' ? parseVariablesFromMarkdown(parsed) : [];

  let badge: React.ReactNode = null;
  if (status === 'completed' && variables.length > 0) {
    badge = <Badge text={`${variables.length} vars`} variant="gray" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const description = 'List variables';


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {variables.length > 0 && (
          <ScrollView
            style={{ maxHeight: 260, backgroundColor: c.bgInner, borderRadius: 5 }}
            showsVerticalScrollIndicator
          >
            <YStack paddingVertical={4}>
              {variables.map((v, i) => (
                <VariableRow key={i} name={v.name} value={v.value} isMasked={v.masked} />
              ))}
            </YStack>
          </ScrollView>
        )}
        {typeof parsed === 'string' && variables.length === 0 && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8}>
            <Text color={c.text2} fontSize={9}>
              {parsed}
            </Text>
          </YStack>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function SetVariablesRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRailwayColors();
  const colors = useRailwayColors();

  const parsed = output
    ? parseOutput<{ message: string; variables: string[] }>(output)
    : null;
  const isResult =
    parsed && typeof parsed === 'object' && 'message' in parsed && 'variables' in parsed;

  const varCount =
    isResult && Array.isArray((parsed as any).variables)
      ? (parsed as any).variables.length
      : input?.variables
        ? Object.keys(input.variables).length
        : 0;

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text={varCount > 0 ? `${varCount} set` : 'set'} variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const description = `Set variables${varCount > 0 ? ` (${varCount})` : ''}`;


  const varKeys: string[] = isResult
    ? (parsed as any).variables
    : input?.variables
      ? Object.keys(input.variables)
      : [];

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isResult && (
          <SuccessBlock message={(parsed as any).message} />
        )}
        {varKeys.length > 0 && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} paddingVertical={4}>
            {varKeys.map((key, i) => (
              <XStack key={i} alignItems="center" gap={8} paddingVertical={4} paddingHorizontal={8}>
                <Text color={colors.railwayRed} fontSize={9} fontFamily="$mono">
                  {key}
                </Text>
                <Badge text="updated" variant="success" />
              </XStack>
            ))}
          </YStack>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}
