/**
 * Linear Renderer - Projects
 *
 * Handles: linear-list-projects, linear-create-project
 */

import { ExternalLink } from '@tamagui/lucide-icons';
import type React from 'react';
import { useState } from 'react';
import { Linking, ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import type { ToolCallRendererProps } from '../../types';
import {
  Badge,
  colors,
  ErrorBlock,
  ExpandedBody,
  ExpandedContainer,
  HeaderRow,
  isSuccessMessage,
  type LinearProject,
  parseOutput,
  SuccessBlock,
  truncate,
} from './shared';

// ============================================================================
// Content Blocks
// ============================================================================

function ProjectListBlock({ projects }: { projects: LinearProject[] }) {
  return (
    <ScrollView
      style={{ maxHeight: 250, backgroundColor: colors.bgInner, borderRadius: 5 }}
      showsVerticalScrollIndicator={true}
    >
      <YStack paddingVertical={4}>
        {projects.map((project) => (
          <XStack
            key={project.id}
            alignItems="center"
            gap={8}
            paddingVertical={5}
            paddingHorizontal={8}
            hoverStyle={{ backgroundColor: 'rgba(255,255,255,0.02)' }}
            cursor="pointer"
            onPress={() => project.url && Linking.openURL(project.url)}
          >
            <Text flex={1} color={colors.primary} fontSize={10} fontWeight="500">
              {project.name}
            </Text>
            {project.state && <Badge text={project.state} variant="info" />}
            {project.url && <ExternalLink size={10} color={colors.muted} />}
          </XStack>
        ))}
      </YStack>
    </ScrollView>
  );
}

function ProjectDetailBlock({ project }: { project: LinearProject }) {
  return (
    <YStack
      backgroundColor="rgba(34,197,94,0.1)"
      borderRadius={5}
      paddingVertical={8}
      paddingHorizontal={10}
      gap={4}
    >
      <XStack alignItems="center" gap={8}>
        <Text flex={1} color={colors.bright} fontSize={11} fontWeight="500">
          {project.name}
        </Text>
        {project.state && <Badge text={project.state} variant="info" />}
        {project.url && (
          <XStack
            cursor="pointer"
            onPress={() => Linking.openURL(project.url!)}
            hoverStyle={{ opacity: 0.7 }}
          >
            <ExternalLink size={12} color={colors.secondary} />
          </XStack>
        )}
      </XStack>
      {project.description && (
        <Text color={colors.secondary} fontSize={9} numberOfLines={2}>
          {project.description}
        </Text>
      )}
    </YStack>
  );
}

// ============================================================================
// Renderers
// ============================================================================

export function ListProjectsRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const parsed = output
    ? parseOutput<{ count?: number; projects?: LinearProject[] } | LinearProject[]>(output)
    : null;

  // Handle both { projects: [...] } and direct array formats
  const projects =
    parsed && typeof parsed === 'object' && 'projects' in parsed
      ? (parsed as { projects: LinearProject[] }).projects
      : Array.isArray(parsed)
        ? parsed
        : null;
  const isProjectArray =
    Array.isArray(projects) &&
    projects.length > 0 &&
    'name' in projects[0] &&
    !('key' in projects[0]);

  let description = 'List projects';
  if (input?.teamId) description += ` (team)`;

  let badge: React.ReactNode = null;
  if (status === 'completed' && isProjectArray) {
    badge = <Badge text={`${projects!.length} projects`} variant="gray" />;
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
        {isProjectArray && <ProjectListBlock projects={projects!} />}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}

export function CreateProjectRenderer({
  input,
  status,
  output,
  error,
  duration,
}: ToolCallRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const parsed = output ? parseOutput<LinearProject | string>(output) : null;
  const isSingleProject =
    parsed && !Array.isArray(parsed) && typeof parsed === 'object' && 'name' in parsed;
  const isSuccess = isSuccessMessage(parsed);

  const description = input?.name ? `Create: ${truncate(input.name, 35)}` : 'Create project';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="created" variant="success" />;
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
        {isSingleProject && <ProjectDetailBlock project={parsed as LinearProject} />}
        {isSuccess && typeof parsed === 'string' && <SuccessBlock message={parsed} />}
        {error && <ErrorBlock error={error} />}
      </ExpandedBody>
    </ExpandedContainer>
  );
}
