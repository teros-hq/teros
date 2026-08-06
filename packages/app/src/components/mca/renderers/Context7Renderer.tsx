/**
 * mca.context7 — Tool Call Renderer
 *
 * Cobertura 100%: cada tool del MCA Context7 tiene un sub-renderer dedicado
 * que pinta los datos devueltos componiendo primitivos globales.
 *
 * Tools cubiertas:
 *   - resolve-library  → tabla de candidatos con reputation + benchmarkScore
 *   - get-docs         → snippets estructurados con code blocks
 *   - -health-check    → header colapsado (interno)
 *
 * Patrón TER-281: constantes/tipos/helpers/factory en `./context7/shared.tsx`.
 * Sub-renderers viven aquí (alinear con filesystem-v2 monolítico). El único
 * componente local fuera de primitivos globales es `CodeSnippetBlock`, que
 * se promociona cuando un segundo MCA de docs lo requiera.
 */

import { Book } from '../primitives';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Text, XStack, YStack } from 'tamagui';

import {
  Badge,
  Empty,
  EntityRow,
  ErrorBlock,
  IconTile,
  MetaStrip,
  PillList,
  ResourceCard,
  StatusDot,
  ToolCallCard,
  colors,
  useColors,
  formatDuration,
  getShortToolName,
  truncate,
} from '../primitives';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';
import { CodeSnippetBlock } from './context7/CodeSnippetBlock';
import {
  Context7ToolShell,
  type GetDocsOutput,
  LIST_RENDER_CAP,
  type ResolveLibraryOutput,
  anonymousChipProps,
  context7ErrorProps,
  libraryAccent,
  libraryInitials,
  reputationChipProps,
  statusType,
  unwrap,
} from './context7/shared';

// ────────────────────────────────────────────────────────────────────────────
// SUB-RENDERER: resolve-library
// ────────────────────────────────────────────────────────────────────────────

function ResolveLibraryRenderer(props: ToolCallRendererProps): React.ReactNode {
  const c = useColors();
  const { t } = useTranslation();
  const { toolName, input, status, output, error, duration, appIcon } = props;
  const data = unwrap<ResolveLibraryOutput>(output);
  const libraryName = (input?.libraryName as string) || data?.libraryName || '';
  const query = (input?.query as string) || data?.query || '';
  const candidates = (data?.candidates ?? []).slice(0, LIST_RENDER_CAP);

  const description = `Resolve library: ${truncate(libraryName, 40)}${query ? ` (${truncate(query, 30)})` : ''}`;

  const headerBadge =
    status === 'failed'
      ? <Badge text="failed" variant="error" />
      : data
        ? (
          <PillList
            items={[
              <Badge key="count" text={`${candidates.length}`} variant="info" />,
              ...(data.cached ? [<Badge key="cached" text="cached" variant="gray" />] : []),
              ...(anonymousChipProps(data.resolvedFrom)
                ? [<Badge key="anon" {...anonymousChipProps(data.resolvedFrom)!} />]
                : []),
            ]}
            max={3}
          />
        )
        : undefined;

  return (
    <Context7ToolShell
      toolName={getShortToolName(toolName)}
      status={status}
      appIcon={appIcon}
      description={description}
      badge={headerBadge}
    >
      {status === 'failed' ? (
        <ErrorBlock {...context7ErrorProps(error ?? 'Resolve failed', 'resolve-library')} />
      ) : candidates.length === 0 ? (
        <Empty message={t('mca.context7.noMatchingLibraries')} />
      ) : (
        <YStack
          backgroundColor={c.bgInner}
          borderRadius={6}
          borderWidth={1}
          borderColor={c.border}
          overflow="hidden"
        >
          {candidates.map((candidate) => {
            const repProps = reputationChipProps(candidate.reputation);
            return (
              <EntityRow
                key={candidate.id}
                leading={
                  <IconTile
                    size={28}
                    label={libraryInitials(candidate.title)}
                    accent={libraryAccent(candidate.id)}
                  />
                }
                title={candidate.title}
                subtitle={candidate.id}
                badges={
                  repProps || candidate.snippetsCount > 0 ? (
                    <XStack gap={4} alignItems="center">
                      {repProps && <Badge text={repProps.text} variant={repProps.variant} />}
                      {candidate.snippetsCount > 0 && (
                        <Badge text={`${candidate.snippetsCount} snippets`} variant="gray" />
                      )}
                    </XStack>
                  ) : undefined
                }
                meta={
                  <Text color={c.text3} fontSize={9} fontFamily="$mono">
                    {candidate.benchmarkScore.toFixed(0)}
                  </Text>
                }
              />
            );
          })}
        </YStack>
      )}
    </Context7ToolShell>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// SUB-RENDERER: get-docs
// ────────────────────────────────────────────────────────────────────────────

function GetDocsRenderer(props: ToolCallRendererProps): React.ReactNode {
  const c = useColors();
  const { t } = useTranslation();
  const { toolName, input, status, output, error, duration, appIcon } = props;
  const data = unwrap<GetDocsOutput>(output);
  const libraryId = (input?.libraryId as string) || data?.libraryId || '';
  const query = (input?.query as string) || data?.query || '';
  const snippets = data?.snippets ?? [];
  const totalReturned = data?.totalReturned ?? snippets.length;

  const description = `Docs: ${truncate(libraryId, 30)} — ${truncate(query, 30)}`;

  const headerBadge =
    status === 'failed'
      ? <Badge text="failed" variant="error" />
      : data
        ? (
          <PillList
            items={[
              <Badge key="count" text={`${totalReturned}`} variant="info" />,
              ...(anonymousChipProps(data.resolvedFrom)
                ? [<Badge key="anon" {...anonymousChipProps(data.resolvedFrom)!} />]
                : []),
            ]}
            max={3}
          />
        )
        : undefined;

  // MetaStrip: metadata densa solo cuando hay datos válidos para resaltar
  // limit applied vs returned, sin reemplazar la lista de snippets.
  const metaItems =
    data && snippets.length > 0
      ? [
          { key: 'returned', value: `${totalReturned}` },
          { key: 'snippets', value: `${snippets.length}` },
          ...(data.resolvedFrom === 'anonymous'
            ? [{ key: 'pool', value: 'anonymous', accent: colors.amber }]
            : []),
        ]
      : null;

  return (
    <Context7ToolShell
      toolName={getShortToolName(toolName)}
      status={status}
      appIcon={appIcon}
      description={description}
      badge={headerBadge}
    >
      {status === 'failed' ? (
        <ErrorBlock {...context7ErrorProps(error ?? 'Docs fetch failed', 'get-docs')} />
      ) : snippets.length === 0 ? (
        <Empty message={t('mca.context7.noSnippets')} />
      ) : (
        <YStack gap={6}>
          <ResourceCard
            leading={
              <IconTile size={28} icon={<Book size={14} color={colors.indigo} />} accent={colors.indigo} />
            }
            title={libraryId}
            subtitle={query}
          />
          {metaItems && <MetaStrip items={metaItems} />}
          {snippets.map((s, i) => (
            <CodeSnippetBlock key={`${s.source}-${i}`} snippet={s} />
          ))}
        </YStack>
      )}
    </Context7ToolShell>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// SUB-RENDERER: -health-check (interno — no UI rica, solo header)
// ────────────────────────────────────────────────────────────────────────────

function HealthCheckRenderer(props: ToolCallRendererProps): React.ReactNode {
  const c = useColors();
  const { toolName, status, duration, appIcon } = props;
  return (
    <Context7ToolShell
      toolName={getShortToolName(toolName)}
      status={status}
      appIcon={appIcon}
      defaultExpanded={false}
    />
  );
}

// ────────────────────────────────────────────────────────────────────────────
// FALLBACK (señal de bug — no debería aparecer en producción)
// ────────────────────────────────────────────────────────────────────────────

function FallbackRenderer(props: ToolCallRendererProps): React.ReactNode {
  const c = useColors();
  if (typeof console !== 'undefined') {
    console.warn(`[Context7Renderer] No dedicated renderer for tool: ${props.toolName}`);
  }
  return (
    <XStack
      alignItems="center"
      gap={6}
      padding={8}
      backgroundColor={c.bgCard}
      borderRadius={6}
      borderWidth={1}
      borderColor={c.border}
    >
      <StatusDot status={statusType(props.status)} />
      <Text color={c.text} fontSize={11} flex={1}>
        {getShortToolName(props.toolName)}
      </Text>
      {props.duration !== undefined && (
        <Text color={c.text3} fontSize={9} fontFamily="$mono">
          {formatDuration(props.duration)}
        </Text>
      )}
    </XStack>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// REGISTRY (cobertura 100%)
// ────────────────────────────────────────────────────────────────────────────

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  'resolve-library': ResolveLibraryRenderer,
  'get-docs': GetDocsRenderer,
  '-health-check': HealthCheckRenderer,
};

function Context7RendererBase(props: ToolCallRendererProps): React.ReactNode {
  const c = useColors();
  const shortName = getShortToolName(props.toolName);
  const Renderer = RENDERERS[shortName] ?? FallbackRenderer;
  return <Renderer {...props} />;
}

export const Context7ToolCallRenderer = withPermissionSupport(Context7RendererBase);
export default Context7ToolCallRenderer;
