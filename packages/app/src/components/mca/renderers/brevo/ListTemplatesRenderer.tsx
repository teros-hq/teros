/**
 * Brevo — list-email-templates.
 */

import { YStack } from 'tamagui';
import {
  Badge,
  Empty,
  EntityRow,
  ErrorBlock,
  FileText,
  IconChip,
  IconTile,
  MAX_ITEMS,
  ToolCallCard,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { BREVO_BRAND, type ListTemplatesResult, narrowObject, templateStatusChipProps, useBrevoColors } from './shared';

export function ListTemplatesRenderer({ status, output, error, appIcon }: ToolCallRendererProps) {
  const c = useBrevoColors();
  const data = output ? narrowObject<ListTemplatesResult>(parseOutput<ListTemplatesResult>(output)) : null;
  const templates = data?.templates ?? [];
  const count = data?.count ?? templates.length;
  const displayError = error || (status === 'failed' ? output : null);

  const badge =
    status === 'failed' ? (
      <Badge text="failed" variant="error" />
    ) : (
      <Badge
        text={`${count} ${count === 1 ? 'template' : 'templates'}`}
        variant={count > 0 ? 'info' : 'gray'}
      />
    );

  const visible = templates.slice(0, MAX_ITEMS);

  return (
    <ToolCallCard
      status={status}
      verb="List templates"
      badge={badge}
      iconUri={appIcon}
      animateExpand
      defaultExpanded={status === 'completed' && templates.length > 0}
    >
      {displayError ? (
        <ErrorBlock error={displayError} />
      ) : status === 'completed' ? (
        templates.length > 0 ? (
          <YStack
            backgroundColor={c.bgInner}
            borderRadius={6}
            borderWidth={1}
            borderColor={c.border}
            overflow="hidden"
          >
            {visible.map((t, i) => {
              const statusChip = templateStatusChipProps(t.isActive);
              return (
                <EntityRow
                  key={t.id ?? t.name ?? i}
                  leading={
                    <IconTile
                      accent={BREVO_BRAND.royalBlue}
                      icon={<FileText size={14} color={BREVO_BRAND.royalBlue} />}
                      size={24}
                    />
                  }
                  title={t.name ?? '(unnamed template)'}
                  subtitle={t.subject ?? undefined}
                  badges={
                    statusChip ? <IconChip text={statusChip.text} accent={statusChip.accent} /> : undefined
                  }
                  meta={t.tag ? <IconChip text={t.tag} accent={BREVO_BRAND.green} /> : undefined}
                />
              );
            })}
          </YStack>
        ) : (
          <Empty
            icon={<FileText size={20} color={c.muted} />}
            message="No templates"
            hint="Create one with create-email-template."
          />
        )
      ) : null}
    </ToolCallCard>
  );
}
