/**
 * Render MCA Renderer - Environment Variables
 *
 * Handles: render-list-env-vars, render-set-env-vars, render-update-env-var, render-delete-env-var
 */

import type React from 'react';
import { ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import type { ToolCallRendererProps } from '../../types';
import { ErrorBlock, SuccessBlock, ToolCallCard } from '../../primitives';
import {
  Badge,
  useRenderColors,
  isSuccessOutput,
  KeyValueRow,
  parseOutput,
  type RenderEnvVar,
  truncate,
} from './shared';

// ============================================================================
// Helpers
// ============================================================================

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.includes('secret') ||
    lower.includes('password') ||
    lower.includes('token') ||
    lower.includes('key') ||
    lower.includes('api') ||
    lower.includes('auth') ||
    lower.includes('private')
  );
}

function maskValue(key: string, value: string): string {
  if (isSensitiveKey(key)) return '•••••••••';
  if (value.length > 50) return value.slice(0, 50) + '…';
  return value;
}

// ============================================================================
// Content Blocks
// ============================================================================

function EnvVarRow({ envVar }: { envVar: RenderEnvVar }) {
  const c = useRenderColors();
  const colors = useRenderColors();
  const sensitive = isSensitiveKey(envVar.key);
  const displayValue = maskValue(envVar.key, envVar.value);

  return (
    <XStack
      alignItems="center"
      gap={8}
      paddingVertical={4}
      paddingHorizontal={8}
      hoverStyle={{ backgroundColor: c.bgCardHover }}
    >
      <Text
        color={colors.renderGreen}
        fontSize={9}
        fontFamily="$mono"
        width={130}
        numberOfLines={1}
        flexShrink={0}
      >
        {envVar.key}
      </Text>
      <Text
        flex={1}
        color={sensitive ? c.text3 : c.text2}
        fontSize={9}
        fontFamily="$mono"
        numberOfLines={1}
      >
        {displayValue}
      </Text>
      {sensitive && (
        <XStack
          backgroundColor={c.badges.gray.bg}
          paddingHorizontal={3}
          paddingVertical={1}
          borderRadius={2}
        >
          <Text color={c.text3} fontSize={8}>
            hidden
          </Text>
        </XStack>
      )}
    </XStack>
  );
}

// ============================================================================
// Renderers
// ============================================================================

export function ListEnvVarsRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRenderColors();
  const colors = useRenderColors();
  // Output is a markdown string; try JSON first
  const parsed = output ? parseOutput<RenderEnvVar[]>(output) : null;
  const envVars = Array.isArray(parsed) ? parsed : null;
  const isEnvArray = Array.isArray(envVars) && envVars.length > 0 && 'key' in envVars[0];

  const description = input?.serviceId
    ? `Env vars for ${truncate(input.serviceId, 20)}`
    : 'List env vars';

  let badge: React.ReactNode = null;
  if (status === 'completed' && isEnvArray) {
    badge = <Badge text={`${envVars!.length} vars`} variant="gray" />;
  } else if (status === 'completed') {
    badge = <Badge text="done" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isEnvArray && (
          <ScrollView
            style={{ maxHeight: 250, backgroundColor: c.bgInner, borderRadius: 5 }}
            showsVerticalScrollIndicator
          >
            <YStack paddingVertical={4}>
              {envVars!.map((ev) => (
                <EnvVarRow key={ev.key} envVar={ev} />
              ))}
            </YStack>
          </ScrollView>
        )}
        {!isEnvArray && typeof parsed === 'string' && (
          <Text color={c.text2} fontSize={10}>
            {parsed}
          </Text>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function SetEnvVarsRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRenderColors();
  const colors = useRenderColors();
  const parsed = output
    ? parseOutput<{ message?: string; keys?: string[] }>(output)
    : null;
  const isResult = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'keys' in parsed;
  const isSuccess = isSuccessOutput(parsed);

  const varCount = Array.isArray(input?.envVars) ? input.envVars.length : 0;
  const description = varCount > 0 ? `Set ${varCount} env var${varCount > 1 ? 's' : ''}` : 'Set env vars';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="set" variant="success" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  


  const result = parsed as { message?: string; keys?: string[] } | null;

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isResult && result && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8} gap={4}>
            {result.message && <SuccessBlock message={result.message} />}
            {result.keys && result.keys.length > 0 && (
              <YStack gap={2} marginTop={4}>
                <Text color={c.text3} fontSize={9} marginBottom={2}>
                  Variables updated:
                </Text>
                {result.keys.map((k) => (
                  <XStack key={k} alignItems="center" gap={6}>
                    <Text color={c.text3} fontSize={9}>
                      •
                    </Text>
                    <Text color={colors.renderGreen} fontSize={9} fontFamily="$mono">
                      {k}
                    </Text>
                  </XStack>
                ))}
              </YStack>
            )}
          </YStack>
        )}
        {!isResult && isSuccess && typeof parsed === 'object' && (parsed as { message?: string }).message && (
          <SuccessBlock message={(parsed as { message: string }).message} />
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function UpdateEnvVarRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const c = useRenderColors();
  const colors = useRenderColors();
  const parsed = output
    ? parseOutput<{ message?: string; key?: string }>(output)
    : null;
  const isResult = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'key' in parsed;

  const description = input?.key
    ? `Update ${input.key}`
    : 'Update env var';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="updated" variant="info" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  


  const result = parsed as { message?: string; key?: string } | null;

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isResult && result && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8} gap={4}>
            {result.message && <SuccessBlock message={result.message} />}
            {result.key && <KeyValueRow label="Key" value={result.key} mono />}
          </YStack>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function DeleteEnvVarRenderer({
  input,
  status,
  appIcon,
  output,
  error,
}: ToolCallRendererProps) {
  const colors = useRenderColors();
  const parsed = output
    ? parseOutput<{ message?: string; deleted?: boolean }>(output)
    : null;
  const isResult = parsed && typeof parsed === 'object' && !Array.isArray(parsed);

  const description = input?.key
    ? `Delete ${input.key}`
    : 'Delete env var';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="deleted" variant="error" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  


  const result = parsed as { message?: string } | null;

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isResult && result?.message && <SuccessBlock message={result.message} />}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}
