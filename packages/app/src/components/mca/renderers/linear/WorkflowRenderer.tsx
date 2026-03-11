/**
 * Linear Renderer - Workflow States
 *
 * Handles: linear-list-workflow-states
 */

import { Circle } from '@tamagui/lucide-icons';
import type React from 'react';
import { useState } from 'react';
import { Text, XStack, YStack } from 'tamagui';

import type { ToolCallRendererProps } from '../../types';
import {
  Badge,
  colors,
  ErrorBlock,
  ExpandedBody,
  ExpandedContainer,
  HeaderRow,
  type LinearWorkflowState,
  parseOutput,
} from './shared';

// ============================================================================
// Content Blocks
// ============================================================================

function WorkflowStateListBlock({ states }: { states: LinearWorkflowState[] }) {
  return (
    <YStack backgroundColor={colors.bgInner} borderRadius={5} paddingVertical={4}>
      {states.map((state) => (
        <XStack
          key={state.id}
          alignItems="center"
          gap={8}
          paddingVertical={4}
          paddingHorizontal={8}
        >
          <Circle
            size={10}
            color={state.color || colors.statusBacklog}
            fill={state.color || colors.statusBacklog}
          />
          <Text flex={1} color={colors.primary} fontSize={10}>
            {state.name}
          </Text>
          {state.type && <Badge text={state.type} variant="gray" />}
        </XStack>
      ))}
    </YStack>
  );
}

// ============================================================================
// Renderers
// ============================================================================

export function ListWorkflowStatesRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const parsed = output
    ? parseOutput<{ count?: number; states?: LinearWorkflowState[] } | LinearWorkflowState[]>(
        output,
      )
    : null;

  // Handle both { states: [...] } and direct array formats
  const states =
    parsed && typeof parsed === 'object' && 'states' in parsed
      ? (parsed as { states: LinearWorkflowState[] }).states
      : Array.isArray(parsed)
        ? parsed
        : null;
  const isStateArray = Array.isArray(states) && states.length > 0 && 'type' in states[0];

  let description = 'List workflow states';
  if (input?.teamId) description += ` (team)`;

  let badge: React.ReactNode = null;
  if (status === 'completed' && isStateArray) {
    badge = <Badge text={`${states!.length} states`} variant="gray" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const headerProps = {
    status,
    description,
    duration,
    badge,
    expanded,
    onToggle: () => setExpanded(!expanded),
  };

  if (!expanded) return <HeaderRow {...headerProps} />;

  return (
    <ExpandedContainer>
      <HeaderRow {...headerProps} isInContainer />
      <ExpandedBody>
        {isStateArray && <WorkflowStateListBlock states={states!} />}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}
