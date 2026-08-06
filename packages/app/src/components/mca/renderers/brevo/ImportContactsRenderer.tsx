/**
 * Brevo — import-contacts.
 *
 * The import runs asynchronously: Brevo returns a `processId` and does the
 * work in the background, so the card reports the queued job (process id +
 * target lists + how many contacts / whether from a file), NOT a finished
 * result.
 */

import {
  Badge,
  Empty,
  ErrorBlock,
  IconTile,
  PillList,
  ResourceCard,
  ToolCallCard,
  Upload,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { BREVO_BRAND, type ImportContactsResult, narrowObject } from './shared';

export function ImportContactsRenderer({ status, output, error, appIcon }: ToolCallRendererProps) {
  const data = output ? narrowObject<ImportContactsResult>(parseOutput<ImportContactsResult>(output)) : null;
  const displayError = error || (status === 'failed' ? output : null);
  const listIds = data?.listIds ?? [];

  const inline = data?.source === 'inline';
  const count = data?.contactCount ?? 0;

  const badge =
    status === 'failed' ? (
      <Badge text="failed" variant="error" />
    ) : status === 'completed' ? (
      <Badge text="queued" variant="info" />
    ) : null;

  return (
    <ToolCallCard
      status={status}
      verb="Import contacts"
      badge={badge}
      iconUri={appIcon}
      animateExpand
      defaultExpanded={status === 'completed'}
    >
      {displayError ? (
        <ErrorBlock error={displayError} />
      ) : status === 'completed' && data ? (
        <ResourceCard
          leading={
            <IconTile
              accent={BREVO_BRAND.green}
              icon={<Upload size={16} color={BREVO_BRAND.green} />}
              size={28}
            />
          }
          title={inline ? `${count} contact${count === 1 ? '' : 's'}` : 'Contacts from file'}
          subtitle={data.processId != null ? `process #${data.processId}` : undefined}
        >
          {listIds.length > 0 ? (
            <PillList items={listIds.map((id) => `list ${id}`)} accent={BREVO_BRAND.royalBlue} />
          ) : (
            <Empty message="No target lists" />
          )}
        </ResourceCard>
      ) : null}
    </ToolCallCard>
  );
}
