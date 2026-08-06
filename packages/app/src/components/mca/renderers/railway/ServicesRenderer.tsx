/**
 * Railway Renderer - Services & Environments
 *
 * Handles: railway-list-services, railway-list-environments,
 *          railway-get-user, railway-list-workspaces, railway-list-projects,
 *          railway-get-project
 */

import { ExternalLink } from '../../primitives';
import { ErrorBlock, SuccessBlock, ToolCallCard } from '../../primitives';
import type React from 'react';
import { Linking, ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import type { ToolCallRendererProps } from '../../types';
import {
  Badge,
  useRailwayColors,
  InfoRow,
  parseOutput,
  type RailwayEnvironment,
  type RailwayProject,
  type RailwayService,
  truncate,
} from './shared';

// ============================================================================
// Content Blocks
// ============================================================================

interface ServiceListBlockProps {
  services: RailwayService[];
}

function ServiceListBlock({ services }: ServiceListBlockProps) {
  const c = useRailwayColors();
  const colors = useRailwayColors();
  return (
    <ScrollView
      style={{ maxHeight: 240, backgroundColor: c.bgInner, borderRadius: 5 }}
      showsVerticalScrollIndicator={true}
    >
      <YStack paddingVertical={4}>
        {services.map((svc) => (
          <XStack
            key={svc.id}
            alignItems="center"
            gap={8}
            paddingVertical={5}
            paddingHorizontal={8}
            hoverStyle={{ backgroundColor: c.bgCardHover }}
          >
            <XStack
              width={6}
              height={6}
              borderRadius={3}
              backgroundColor={colors.railwayRed}
              flexShrink={0}
            />
            <Text flex={1} color={c.text} fontSize={10} numberOfLines={1}>
              {svc.name}
            </Text>
            <Text color={c.text3} fontSize={8} fontFamily="$mono" numberOfLines={1}>
              {truncate(svc.id, 20)}
            </Text>
          </XStack>
        ))}
      </YStack>
    </ScrollView>
  );
}

interface EnvListBlockProps {
  environments: RailwayEnvironment[];
}

function EnvListBlock({ environments }: EnvListBlockProps) {
  const c = useRailwayColors();
  const colors = useRailwayColors();
  return (
    <YStack backgroundColor={c.bgInner} borderRadius={5} paddingVertical={4}>
      {environments.map((env) => (
        <XStack
          key={env.id}
          alignItems="center"
          gap={8}
          paddingVertical={5}
          paddingHorizontal={8}
        >
          <XStack
            width={6}
            height={6}
            borderRadius={3}
            backgroundColor={colors.deploying}
            flexShrink={0}
          />
          <Text flex={1} color={c.text} fontSize={10}>
            {env.name}
          </Text>
          <Text color={c.text3} fontSize={8} fontFamily="$mono">
            {truncate(env.id, 20)}
          </Text>
        </XStack>
      ))}
    </YStack>
  );
}

interface ProjectDetailBlockProps {
  project: RailwayProject;
}

function ProjectDetailBlock({ project }: ProjectDetailBlockProps) {
  const c = useRailwayColors();
  const colors = useRailwayColors();
  return (
    <YStack backgroundColor={c.bgInner} borderRadius={5} paddingVertical={8} paddingHorizontal={10} gap={6}>
      <Text color={c.text} fontSize={11} fontWeight="500">
        {project.name}
      </Text>
      {project.description && (
        <Text color={c.text2} fontSize={9} numberOfLines={2}>
          {project.description}
        </Text>
      )}
      {project.createdAt && (
        <InfoRow label="created" value={new Date(project.createdAt).toLocaleDateString()} />
      )}
      {project.environments && project.environments.length > 0 && (
        <YStack gap={3}>
          <Text color={c.text3} fontSize={8} fontFamily="$mono">
            ENVIRONMENTS
          </Text>
          <EnvListBlock environments={project.environments} />
        </YStack>
      )}
      {project.services && project.services.length > 0 && (
        <YStack gap={3}>
          <Text color={c.text3} fontSize={8} fontFamily="$mono">
            SERVICES
          </Text>
          <ServiceListBlock services={project.services} />
        </YStack>
      )}
    </YStack>
  );
}

// ============================================================================
// Parsers for markdown output
// ============================================================================

function parseProjectsFromMarkdown(text: string): Array<{ name: string; id: string }> {
  const results: Array<{ name: string; id: string }> = [];
  // Match lines like: **ProjectName** (id)
  const regex = /\*\*(.+?)\*\*\s*\(([^)]+)\)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    results.push({ name: match[1], id: match[2] });
  }
  return results;
}

function parseWorkspacesFromMarkdown(text: string): Array<{ name: string; id: string }> {
  return parseProjectsFromMarkdown(text);
}

// ============================================================================
// Renderers
// ============================================================================

export function GetUserRenderer({ status, appIcon, output, error, duration }: ToolCallRendererProps) {
  const c = useRailwayColors();
  const colors = useRailwayColors();

  const parsed = output ? parseOutput<string>(output) : null;
  const isText = typeof parsed === 'string';

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="user" variant="info" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const description = 'Get Railway user';


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {isText && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8}>
            <Text color={c.text2} fontSize={9} fontFamily="$mono" numberOfLines={12}>
              {parsed}
            </Text>
          </YStack>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function ListWorkspacesRenderer({ status, appIcon, output, error, duration }: ToolCallRendererProps) {
  const c = useRailwayColors();
  const colors = useRailwayColors();

  const parsed = output ? parseOutput<string>(output) : null;
  const workspaces =
    typeof parsed === 'string' ? parseWorkspacesFromMarkdown(parsed) : [];

  let badge: React.ReactNode = null;
  if (status === 'completed' && workspaces.length > 0) {
    badge = <Badge text={`${workspaces.length} workspaces`} variant="gray" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const description = 'List workspaces';


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {workspaces.length > 0 && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} paddingVertical={4}>
            {workspaces.map((ws) => (
              <XStack key={ws.id} alignItems="center" gap={8} paddingVertical={5} paddingHorizontal={8}>
                <Text flex={1} color={c.text} fontSize={10}>{ws.name}</Text>
                <Text color={c.text3} fontSize={8} fontFamily="$mono">{truncate(ws.id, 24)}</Text>
              </XStack>
            ))}
          </YStack>
        )}
        {typeof parsed === 'string' && workspaces.length === 0 && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8}>
            <Text color={c.text2} fontSize={9}>{parsed}</Text>
          </YStack>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function ListProjectsRenderer({ status, appIcon, output, error, duration }: ToolCallRendererProps) {
  const c = useRailwayColors();
  const colors = useRailwayColors();

  const parsed = output ? parseOutput<string>(output) : null;
  const projects =
    typeof parsed === 'string' ? parseProjectsFromMarkdown(parsed) : [];

  let badge: React.ReactNode = null;
  if (status === 'completed' && projects.length > 0) {
    badge = <Badge text={`${projects.length} projects`} variant="gray" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const description = 'List projects';


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {projects.length > 0 && (
          <ScrollView
            style={{ maxHeight: 240, backgroundColor: c.bgInner, borderRadius: 5 }}
            showsVerticalScrollIndicator
          >
            <YStack paddingVertical={4}>
              {projects.map((p) => (
                <XStack key={p.id} alignItems="center" gap={8} paddingVertical={5} paddingHorizontal={8}>
                  <XStack
                    width={6}
                    height={6}
                    borderRadius={3}
                    backgroundColor={colors.railwayRed}
                    flexShrink={0}
                  />
                  <Text flex={1} color={c.text} fontSize={10}>{p.name}</Text>
                  <Text color={c.text3} fontSize={8} fontFamily="$mono">{truncate(p.id, 20)}</Text>
                </XStack>
              ))}
            </YStack>
          </ScrollView>
        )}
        {typeof parsed === 'string' && projects.length === 0 && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8}>
            <Text color={c.text2} fontSize={9}>{parsed}</Text>
          </YStack>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function GetProjectRenderer({ input, status, appIcon, output, error, duration }: ToolCallRendererProps) {
  const c = useRailwayColors();
  const colors = useRailwayColors();

  const parsed = output ? parseOutput<string>(output) : null;

  // Extract project name from markdown header
  let projectName = input?.projectId ? truncate(input.projectId, 20) : 'Get project';
  if (typeof parsed === 'string') {
    const match = parsed.match(/# Project: (.+)/);
    if (match) projectName = match[1];
  }

  let badge: React.ReactNode = null;
  if (status === 'completed') {
    badge = <Badge text="project" variant="info" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const description = projectName;


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {typeof parsed === 'string' && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8} gap={4}>
            {parsed.split('\n').filter(Boolean).map((line, i) => (
              <Text key={i} color={c.text2} fontSize={9} fontFamily="$mono">
                {line.replace(/\*\*/g, '')}
              </Text>
            ))}
          </YStack>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function ListServicesRenderer({ input, status, appIcon, output, error, duration }: ToolCallRendererProps) {
  const c = useRailwayColors();
  const colors = useRailwayColors();

  const parsed = output ? parseOutput<string>(output) : null;
  const services: RailwayService[] =
    typeof parsed === 'string'
      ? parseProjectsFromMarkdown(parsed).map((p) => ({ id: p.id, name: p.name }))
      : [];

  let badge: React.ReactNode = null;
  if (status === 'completed' && services.length > 0) {
    badge = <Badge text={`${services.length} services`} variant="gray" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const description = 'List services';


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {services.length > 0 && <ServiceListBlock services={services} />}
        {typeof parsed === 'string' && services.length === 0 && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8}>
            <Text color={c.text2} fontSize={9}>{parsed}</Text>
          </YStack>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}

export function ListEnvironmentsRenderer({ input, status, appIcon, output, error, duration }: ToolCallRendererProps) {
  const c = useRailwayColors();
  const colors = useRailwayColors();

  const parsed = output ? parseOutput<string>(output) : null;
  const envs: RailwayEnvironment[] =
    typeof parsed === 'string'
      ? parseProjectsFromMarkdown(parsed).map((p) => ({ id: p.id, name: p.name }))
      : [];

  let badge: React.ReactNode = null;
  if (status === 'completed' && envs.length > 0) {
    badge = <Badge text={`${envs.length} envs`} variant="gray" />;
  } else if (status === 'failed') {
    badge = <Badge text="failed" variant="error" />;
  }

  const description = 'List environments';


  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
        {envs.length > 0 && <EnvListBlock environments={envs} />}
        {typeof parsed === 'string' && envs.length === 0 && (
          <YStack backgroundColor={c.bgInner} borderRadius={5} padding={8}>
            <Text color={c.text2} fontSize={9}>{parsed}</Text>
          </YStack>
        )}
        {error && <ErrorBlock error={error} />}
      </ToolCallCard>
  );
}
