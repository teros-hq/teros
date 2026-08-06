/**
 * Bash Renderer Core — shared implementation for `mca.teros.bash` and
 * `mca.teros.admin.bash`.
 *
 * Both MCAs render exactly the same UI (compact terminal-style header
 * + expanded body with CommandRow + OutputBlock). The ONLY differences
 * are:
 *   • the default `mcaId` used to route through the per-call
 *     heuristics registry (`isToolCallIrreversible`,
 *     `isToolCallElevatedRisk`),
 *   • cosmetic differences in their wrapper files (display name,
 *     `withPermissionSupport(...)` invocation).
 *
 * Rather than duplicate ~550 LOC across `BashRenderer.tsx` and
 * `AdminBashRenderer.tsx`, this factory keeps the body in one place.
 * The two wrapper files become ~10-line shims that call
 * `createBashRendererBase(...)`.
 */

import { getShortToolName, ToolCallCard, useColors } from '../primitives';
import type React from 'react';
import { ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import type { ToolCallRendererProps } from '../types';
import { getBashPermissionDescription } from './bash-permission-description';
import { isToolCallElevatedRisk, isToolCallIrreversible } from './permission-heuristics';

// ============================================================================
// Colors — Renderer UX Guide v2 §5 (theme-adaptive).
// ============================================================================

function useBashColors() {
  const c = useColors();
  return {
    exitSuccess: c.badges.ok,
    exitError: c.badges.err,
    secondary: c.text2,
    muted: c.text3,
    bright: c.text,
    prompt: '#22c55e',
    command: c.text,
    cwd: c.text3,
    lineNum: c.text3,
    bgCommand: c.bgInner,
    bgOutput: c.bgInner,
  };
}

// ============================================================================
// Utilities
// ============================================================================

function parseOutput(output: string): {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  duration?: string;
  cwd?: string;
} {
  try {
    return JSON.parse(output);
  } catch {
    return { stdout: output };
  }
}

function getOutputLines(text: string, maxLines: number = 20): { num: number; text: string }[] {
  const lines = text.split('\n');
  return lines.slice(0, maxLines).map((line, idx) => ({
    num: idx + 1,
    text: line,
  }));
}

// ============================================================================
// Components
// ============================================================================

interface ExitCodeBadgeProps {
  code: number;
}

function ExitCodeBadge({ code }: ExitCodeBadgeProps) {
  const colors = useBashColors();
  const isSuccess = code === 0;
  const { text, bg } = isSuccess ? colors.exitSuccess : colors.exitError;

  return (
    <XStack backgroundColor={bg} paddingHorizontal={4} paddingVertical={1} borderRadius={3}>
      <Text color={text} fontSize={9} fontFamily="$mono">
        {code}
      </Text>
    </XStack>
  );
}

interface CommandRowProps {
  command: string;
  cwd?: string;
}

function CommandRow({ command, cwd }: CommandRowProps) {
  const colors = useBashColors();
  return (
    <XStack
      alignItems="center"
      gap={6}
      backgroundColor={colors.bgCommand}
      borderRadius={5}
      paddingVertical={6}
      paddingHorizontal={8}
      marginBottom={6}
    >
      <Text color={colors.prompt} fontSize={10} fontFamily="$mono" fontWeight="600">
        $
      </Text>
      <Text flex={1} color={colors.command} fontSize={10} fontFamily="$mono" numberOfLines={3}>
        {command}
      </Text>
      {cwd && (
        <Text color={colors.cwd} fontSize={9} fontFamily="$mono">
          {cwd.replace(/^\/home\/[^/]+/, '~')}
        </Text>
      )}
    </XStack>
  );
}

interface OutputBlockProps {
  stdout?: string;
  stderr?: string;
  error?: string;
}

function OutputBlock({ stdout, stderr, error }: OutputBlockProps) {
  const c = useColors();
  const colors = useBashColors();
  const hasStdout = stdout && stdout.trim().length > 0;
  const hasStderr = stderr && stderr.trim().length > 0;
  const hasError = error && error.trim().length > 0;

  if (!hasStdout && !hasStderr && !hasError) {
    return (
      <YStack
        backgroundColor={colors.bgOutput}
        borderRadius={5}
        paddingVertical={6}
        paddingHorizontal={8}
      >
        <Text color={c.text3} fontSize={10} fontFamily="$mono" fontStyle="italic">
          (no output)
        </Text>
      </YStack>
    );
  }

  return (
    <YStack gap={6}>
      {hasStdout && (
        <ScrollView
          style={{
            maxHeight: 360,
            backgroundColor: colors.bgOutput,
            borderRadius: 5,
          }}
          showsVerticalScrollIndicator={true}
        >
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={true}
            contentContainerStyle={{ minWidth: '100%' }}
          >
            <YStack paddingVertical={6} paddingHorizontal={8}>
              {getOutputLines(stdout).map((line) => (
                <XStack key={line.num} gap={8}>
                  <Text
                    color={colors.lineNum}
                    fontSize={9}
                    fontFamily="$mono"
                    width={16}
                    textAlign="right"
                    flexShrink={0}
                    userSelect="none"
                  >
                    {line.num}
                  </Text>
                  <Text color={c.text2} fontSize={10} fontFamily="$mono" whiteSpace="pre">
                    {line.text}
                  </Text>
                </XStack>
              ))}
            </YStack>
          </ScrollView>
        </ScrollView>
      )}

      {hasStderr && (
        <YStack
          backgroundColor="rgba(239,68,68,0.1)"
          borderRadius={5}
          paddingVertical={6}
          paddingHorizontal={8}
        >
          <Text color={colors.exitError.text} fontSize={10} fontFamily="$mono">
            {stderr}
          </Text>
        </YStack>
      )}

      {hasError && (
        <YStack
          backgroundColor="rgba(239,68,68,0.15)"
          borderRadius={5}
          paddingVertical={6}
          paddingHorizontal={8}
        >
          <Text color={colors.exitError.text} fontSize={10} fontFamily="$mono">
            {error}
          </Text>
        </YStack>
      )}
    </YStack>
  );
}

// ============================================================================
// Main Renderer factory
// ============================================================================

/**
 * Build a renderer for a bash-shaped MCA tool. Pass the default
 * `mcaId` used to look up per-call heuristics in
 * `permission-heuristics.ts`.
 *
 * The factory returns the BASE component — wrap it in
 * `withPermissionSupport` at the public export so the
 * `pending_permission` context is injected before render.
 */
export function createBashRendererBase(defaultMcaId: string) {
  function BashRendererBase(props: ToolCallRendererProps) {
    const { toolName, input, status, output, error, mcaId, appIcon } = props;

    const command = input?.command || '';
    const permissionDescription =
      status === 'pending_permission'
        ? getBashPermissionDescription({ command, description: input?.description, cwd: input?.cwd })
        : null;
    const description = permissionDescription ?? input?.description ?? 'Execute command';
    const cwd = input?.cwd;

    const parsedOutput = output ? parseOutput(output) : null;
    const exitCode = parsedOutput?.exitCode;

    const irreversible =
      status === 'pending_permission' &&
      isToolCallIrreversible(mcaId ?? defaultMcaId, getShortToolName(toolName), input);
    const risk =
      status === 'pending_permission' &&
      isToolCallElevatedRisk(mcaId ?? defaultMcaId, getShortToolName(toolName), input);

    return (
      <ToolCallCard
        status={status}
        description={description}
        iconUri={appIcon}
        badge={exitCode !== undefined ? <ExitCodeBadge code={exitCode} /> : null}
        irreversible={irreversible}
        risk={risk}
      >
        <CommandRow command={command} cwd={cwd} />
        <OutputBlock stdout={parsedOutput?.stdout} stderr={parsedOutput?.stderr} error={error} />
      </ToolCallCard>
    );
  }
  BashRendererBase.displayName = `BashRendererBase(${defaultMcaId})`;
  return BashRendererBase;
}
