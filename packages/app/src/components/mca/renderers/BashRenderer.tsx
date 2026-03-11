/**
 * Bash MCA - Custom Tool Call Renderer
 *
 * Ultra Compact design for bash command executions.
 * Renders terminal-style output with minimal footprint when collapsed,
 * expandable to show full command and output.
 *
 * Design based on "Propuesta 3" mockup with:
 * - Status dot with glow effect (green/cyan/red)
 * - Terminal icon
 * - Description from input
 * - Duration and exit code badges
 * - Collapsed/expanded views
 * - Line numbers in output
 */

import { ChevronRight, Terminal } from '@tamagui/lucide-icons';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';
import { usePulseAnimation } from '../../../hooks/usePulseAnimation';

// ============================================================================
// Colors
// ============================================================================

const colors = {
  // Status dot
  success: '#22c55e',
  running: '#06b6d4',
  failed: '#ef4444',

  // Status glow
  glowSuccess: 'rgba(34, 197, 94, 0.5)',
  glowRunning: 'rgba(6, 182, 212, 0.5)',
  glowFailed: 'rgba(239, 68, 68, 0.5)',

  // Icon
  icon: '#a855f7',

  // Badges
  exitSuccess: { text: '#86efac', bg: 'rgba(34,197,94,0.1)' },
  exitError: { text: '#fca5a5', bg: 'rgba(239,68,68,0.1)' },

  // Text
  primary: '#d4d4d8',
  secondary: '#9ca3af',
  muted: '#52525b',
  bright: '#e4e4e7',

  // Command
  prompt: '#22c55e',
  command: '#e4e4e7',
  cwd: '#52525b',
  lineNum: '#3f3f46',

  // Backgrounds
  bgCommand: 'rgba(0,0,0,0.3)',
  bgOutput: 'rgba(0,0,0,0.2)',
  border: 'rgba(255,255,255,0.04)',

  // Chevron
  chevron: '#3f3f46',
};

// ============================================================================
// Utilities
// ============================================================================

/**
 * Format duration in ms to human readable
 */
function formatDuration(ms?: number): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Parse bash output JSON
 */
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

/**
 * Split output into lines with numbers
 */
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

interface StatusDotProps {
  status: 'running' | 'completed' | 'failed';
}

function StatusDot({ status }: StatusDotProps) {
  const color =
    status === 'running' ? colors.running : status === 'completed' ? colors.success : colors.failed;

  const glow =
    status === 'running'
      ? colors.glowRunning
      : status === 'completed'
        ? colors.glowSuccess
        : colors.glowFailed;

  const pulseAnim = usePulseAnimation(status === 'running');

  return (
    <Animated.View
      style={{
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: color,
        flexShrink: 0,
        opacity: status === 'running' ? pulseAnim : 1,
        // Shadow for glow effect
        shadowColor: glow,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 1,
        shadowRadius: 3,
        elevation: 3,
      }}
    />
  );
}

interface ExitCodeBadgeProps {
  code: number;
}

function ExitCodeBadge({ code }: ExitCodeBadgeProps) {
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

interface HeaderRowProps {
  status: 'running' | 'completed' | 'failed';
  description: string;
  duration?: number;
  exitCode?: number;
  expanded: boolean;
  onToggle: () => void;
  isInContainer?: boolean;
}

function HeaderRow({
  status,
  description,
  duration,
  exitCode,
  expanded,
  onToggle,
  isInContainer,
}: HeaderRowProps) {
  // Rotation animation for chevron
  const rotateAnim = useRef(new Animated.Value(expanded ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(rotateAnim, {
      toValue: expanded ? 1 : 0,
      duration: 150,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: true,
    }).start();
  }, [expanded, rotateAnim]);

  const rotation = rotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '90deg'],
  });

  return (
    <XStack
      alignItems="center"
      gap={8}
      paddingVertical={6}
      paddingHorizontal={10}
      backgroundColor={isInContainer ? 'transparent' : 'rgba(39,39,42,0.6)'}
      borderRadius={isInContainer ? 0 : 8}
      borderWidth={isInContainer ? 0 : 1}
      borderColor={isInContainer ? 'transparent' : colors.border}
      borderBottomWidth={isInContainer ? 1 : 1}
      borderBottomColor={colors.border}
      width={isInContainer ? undefined : '100%'}
      pressStyle={{
        backgroundColor: isInContainer ? 'rgba(255,255,255,0.02)' : 'rgba(45,45,50,0.7)',
      }}
      hoverStyle={{
        backgroundColor: isInContainer ? 'rgba(255,255,255,0.02)' : 'rgba(45,45,50,0.7)',
        borderColor: isInContainer ? 'transparent' : 'rgba(255,255,255,0.08)',
      }}
      onPress={onToggle}
      cursor="pointer"
    >
      <StatusDot status={status} />

      <Terminal size={12} color={colors.icon} />

      <Text flex={1} color={colors.primary} fontSize={11} fontWeight="500" numberOfLines={1}>
        {description}
      </Text>

      {status === 'running' ? (
        <Text color={colors.running} fontSize={9} fontFamily="$mono">
          running
        </Text>
      ) : (
        duration !== undefined && (
          <Text color={colors.muted} fontSize={9} fontFamily="$mono">
            {formatDuration(duration)}
          </Text>
        )
      )}

      {exitCode !== undefined && <ExitCodeBadge code={exitCode} />}

      <Animated.View style={{ transform: [{ rotate: rotation }] }}>
        <ChevronRight size={10} color={colors.chevron} />
      </Animated.View>
    </XStack>
  );
}

interface ExpandedContainerProps {
  children: React.ReactNode;
}

function ExpandedContainer({ children }: ExpandedContainerProps) {
  return (
    <YStack
      backgroundColor="rgba(39,39,42,0.6)"
      borderRadius={8}
      borderWidth={1}
      borderColor={colors.border}
      overflow="hidden"
      width="100%"
    >
      {children}
    </YStack>
  );
}

interface ExpandedBodyProps {
  children: React.ReactNode;
}

function ExpandedBody({ children }: ExpandedBodyProps) {
  return <YStack padding={8}>{children}</YStack>;
}

interface CommandRowProps {
  command: string;
  cwd?: string;
}

function CommandRow({ command, cwd }: CommandRowProps) {
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
        <Text color={colors.muted} fontSize={10} fontFamily="$mono" fontStyle="italic">
          (no output)
        </Text>
      </YStack>
    );
  }

  return (
    <YStack gap={6}>
      {/* stdout */}
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
                  <Text color={colors.secondary} fontSize={10} fontFamily="$mono" whiteSpace="pre">
                    {line.text}
                  </Text>
                </XStack>
              ))}
            </YStack>
          </ScrollView>
        </ScrollView>
      )}

      {/* stderr */}
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

      {/* error (separate from stderr) */}
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
// Main Renderer
// ============================================================================

function BashRendererBase(props: ToolCallRendererProps) {
  const { toolName, input, status, output, error, duration } = props;

  const [expanded, setExpanded] = useState(false);

  const command = input?.command || '';
  const description = input?.description || 'Execute command';
  const cwd = input?.cwd;

  // Parse output
  const parsedOutput = output ? parseOutput(output) : null;
  const exitCode = parsedOutput?.exitCode;

  const headerProps = {
    status,
    description,
    duration,
    exitCode,
    expanded,
    onToggle: () => setExpanded(!expanded),
  };

  // Collapsed view
  if (!expanded) {
    return <HeaderRow {...headerProps} />;
  }

  // Expanded view
  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        <CommandRow command={command} cwd={cwd} />
        <OutputBlock stdout={parsedOutput?.stdout} stderr={parsedOutput?.stderr} error={error} />
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export const BashToolCallRenderer = withPermissionSupport(BashRendererBase);

// Default export for dynamic import
export default BashToolCallRenderer;
