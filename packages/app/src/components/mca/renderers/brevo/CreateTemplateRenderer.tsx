/**
 * Brevo — create-email-template.
 *
 * Templates are inactive by default, so the active/inactive chip is meaningful.
 */

import {
  ErrorBlock,
  FileText,
  IconChip,
  IconTile,
  KeyValueGrid,
  ResourceCard,
  ToolCallCard,
  parseOutput,
} from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { BREVO_BRAND, type CreateTemplateResult, narrowObject, templateStatusChipProps } from './shared';

export function CreateTemplateRenderer({ input, status, output, error, appIcon }: ToolCallRendererProps) {
  const data = output ? narrowObject<CreateTemplateResult>(parseOutput<CreateTemplateResult>(output)) : null;
  const name = data?.templateName ?? (typeof input?.templateName === 'string' ? input.templateName : '');
  const displayError = error || (status === 'failed' ? output : null);
  const statusChip = data ? templateStatusChipProps(data.isActive) : null;

  return (
    <ToolCallCard
      status={status}
      verb="Create template"
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
              accent={BREVO_BRAND.royalBlue}
              icon={<FileText size={16} color={BREVO_BRAND.royalBlue} />}
              size={28}
            />
          }
          title={name || '(unnamed template)'}
          subtitle={data.id != null ? `id ${data.id}` : undefined}
          verb="created"
          meta={statusChip ? <IconChip text={statusChip.text} accent={statusChip.accent} /> : undefined}
        >
          <KeyValueGrid rows={[{ key: 'Subject', value: data.subject }]} />
        </ResourceCard>
      ) : null}
    </ToolCallCard>
  );
}
