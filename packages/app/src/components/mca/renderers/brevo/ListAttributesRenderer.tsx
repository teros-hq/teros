/**
 * Brevo — list-attributes (contact attributes defined in the account).
 */

import { YStack } from 'tamagui';
import {
  Badge,
  Empty,
  EntityRow,
  ErrorBlock,
  IconChip,
  IconTile,
  MAX_ITEMS,
  Tag,
  ToolCallCard,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { BREVO_BRAND, type ListAttributesResult, attributeTypeChipProps, narrowObject, useBrevoColors } from './shared';

export function ListAttributesRenderer({ status, output, error, appIcon }: ToolCallRendererProps) {
  const c = useBrevoColors();
  const data = output ? narrowObject<ListAttributesResult>(parseOutput<ListAttributesResult>(output)) : null;
  const attributes = data?.attributes ?? [];
  const count = data?.count ?? attributes.length;
  const displayError = error || (status === 'failed' ? output : null);

  const badge =
    status === 'failed' ? (
      <Badge text="failed" variant="error" />
    ) : (
      <Badge
        text={`${count} ${count === 1 ? 'attribute' : 'attributes'}`}
        variant={count > 0 ? 'info' : 'gray'}
      />
    );

  const visible = attributes.slice(0, MAX_ITEMS);

  return (
    <ToolCallCard
      status={status}
      verb="List attributes"
      badge={badge}
      iconUri={appIcon}
      animateExpand
      defaultExpanded={status === 'completed' && attributes.length > 0}
    >
      {displayError ? (
        <ErrorBlock error={displayError} />
      ) : status === 'completed' ? (
        attributes.length > 0 ? (
          <YStack
            backgroundColor={c.bgInner}
            borderRadius={6}
            borderWidth={1}
            borderColor={c.border}
            overflow="hidden"
          >
            {visible.map((a, i) => {
              const typeChip = attributeTypeChipProps(a.type);
              return (
                <EntityRow
                  key={a.name ?? i}
                  leading={
                    <IconTile
                      accent={BREVO_BRAND.royalBlue}
                      icon={<Tag size={13} color={BREVO_BRAND.royalBlue} />}
                      size={24}
                    />
                  }
                  title={a.name ?? '(unnamed)'}
                  subtitle={a.category ?? undefined}
                  meta={
                    typeChip ? <IconChip text={typeChip.text} accent={typeChip.accent} /> : undefined
                  }
                />
              );
            })}
          </YStack>
        ) : (
          <Empty icon={<Tag size={20} color={c.muted} />} message="No attributes" />
        )
      ) : null}
    </ToolCallCard>
  );
}
