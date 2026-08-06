/**
 * ActiveCampaign MCA — Tool Call Renderer entry point.
 *
 * 15/15 tool coverage. Sub-renderers compose exclusively global primitives
 * + prop factories from `./activecampaign/shared`. `FallbackRenderer` is
 * dev-only and signals a missing entry in the `RENDERERS` map.
 */

import { Mail, MailX, Send, Tag, TrendingUp, Users } from '@tamagui/lucide-icons';
import type React from 'react';
import { ScrollView } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';

import {
  ActionBadge,
  Avatar,
  Badge,
  DualEntity,
  Empty,
  EntityCard,
  EntityRow,
  ErrorBlock,
  colors as globalColors,
  IconChip,
  IconTile,
  indicators,
  JsonPreview,
  KeyValueGrid,
  type KeyValueRow,
  MetaStrip,
  PillList,
  parseOutput,
  ResourceCard,
  Specsheet,
  type SpecsheetSection,
  SuccessBlock,
  ToolCallCard,
} from '../primitives';
import type { ToolCallRendererProps } from '../types';
import { withPermissionSupport } from '../withPermissionSupport';

import {
  AC_BRAND,
  type AcCampaign,
  type AcContact,
  type AcContactList,
  type AcContactTag,
  type AcDeal,
  type AcList,
  type AcTag,
  ActiveCampaignToolShell,
  activeCampaignErrorHint,
  campaignStatusChipProps,
  clickRate,
  dealStatusChipProps,
  diffFields,
  formatDate,
  formatMoney,
  fullName,
  getShortToolName,
  getToolLabel,
  openRate,
  shortId,
  subscriptionChipProps,
  toolStatusForPrimitive,
  unwrap,
  unwrapList,
} from './activecampaign/shared';

// ============================================================================
// Common atoms
// ============================================================================

function ContactAvatar({
  contact,
  size = 22,
}: {
  contact: AcContact;
  size?: number;
}): React.ReactNode {
  return <Avatar name={fullName(contact)} size={size} />;
}

function FailedBlock({ error }: { error?: string }): React.ReactNode {
  if (!error) return null;
  const hint = activeCampaignErrorHint(error);
  return (
    <YStack gap={4}>
      <ErrorBlock error={error} />
      {hint ? (
        <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
          {hint}
        </Text>
      ) : null}
    </YStack>
  );
}

function PaginationFooter({
  total,
  shown,
  nextOffset,
}: {
  total: number | null;
  shown: number;
  nextOffset: number | null;
}): React.ReactNode {
  const fragments: string[] = [];
  if (total !== null) fragments.push(`${shown} of ${total}`);
  else fragments.push(`${shown} item${shown !== 1 ? 's' : ''}`);
  if (nextOffset !== null) fragments.push(`next offset: ${nextOffset}`);
  return (
    <Text color={globalColors.muted} fontSize={9}>
      {fragments.join(' · ')}
    </Text>
  );
}

// ============================================================================
// Health check
// ============================================================================

interface HealthOutput {
  status?: string;
  issues?: Array<{ code: string; message: string; action?: { description?: string } }>;
  version?: string;
  uptime?: number;
}

function HealthCheckRenderer(props: ToolCallRendererProps) {
  const raw = props.output ? parseOutput<HealthOutput>(props.output) : null;
  const parsed: HealthOutput | null = raw && typeof raw === 'object' ? raw : null;
  const status = parsed?.status ?? 'unknown';
  const issues = parsed?.issues ?? [];

  const badge =
    status === 'ready' ? (
      <Badge text="ready" variant="success" />
    ) : status === 'degraded' ? (
      <Badge text="degraded" variant="warning" />
    ) : status === 'not_ready' ? (
      <Badge text="not ready" variant="error" />
    ) : undefined;

  return (
    <ActiveCampaignToolShell {...props} badge={badge}>
      <FailedBlock error={props.status === 'failed' ? props.error : undefined} />
      {issues.length === 0 && status === 'ready' ? (
        <SuccessBlock message={`ActiveCampaign API reachable · v${parsed?.version ?? '—'}`} />
      ) : null}
      {issues.length > 0 ? (
        <YStack gap={6}>
          {issues.map((issue, idx) => (
            <YStack key={`${issue.code}-${idx}`} gap={2}>
              <ErrorBlock error={`[${issue.code}] ${issue.message}`} />
              {issue.action?.description ? (
                <Text color={globalColors.muted} fontSize={9} fontFamily="$mono">
                  {issue.action.description}
                </Text>
              ) : null}
            </YStack>
          ))}
        </YStack>
      ) : null}
    </ActiveCampaignToolShell>
  );
}

// ============================================================================
// Contacts
// ============================================================================

function ListContactsRenderer(props: ToolCallRendererProps) {
  const parsed = props.output ? parseOutput<unknown>(props.output) : null;
  const { items, total, nextOffset } = unwrapList<AcContact>(parsed, 'contacts');
  const badge =
    props.status === 'completed' ? <Badge text={`${items.length}`} variant="info" /> : undefined;

  return (
    <ActiveCampaignToolShell {...props} badge={badge}>
      <FailedBlock error={props.status === 'failed' ? props.error : undefined} />
      {props.status === 'completed' && items.length === 0 ? <Empty message="No contacts" /> : null}
      {items.length > 0 ? (
        <YStack gap={4}>
          <ScrollView style={{ maxHeight: 360 }}>
            <YStack gap={2}>
              {items.map((c) => (
                <EntityRow
                  key={c.id}
                  leading={<ContactAvatar contact={c} />}
                  title={fullName(c)}
                  subtitle={c.email || shortId(c.id)}
                  trailing={
                    c.phone ? (
                      <Text color={globalColors.muted} fontSize={9}>
                        {c.phone}
                      </Text>
                    ) : undefined
                  }
                />
              ))}
            </YStack>
          </ScrollView>
          <PaginationFooter total={total} shown={items.length} nextOffset={nextOffset} />
        </YStack>
      ) : null}
    </ActiveCampaignToolShell>
  );
}

function GetContactRenderer(props: ToolCallRendererProps) {
  const parsed = props.output ? parseOutput<unknown>(props.output) : null;
  const contact = unwrap<AcContact>(parsed, 'contact');

  return (
    <ActiveCampaignToolShell {...props}>
      <FailedBlock error={props.status === 'failed' ? props.error : undefined} />
      {props.status === 'completed' && contact ? (
        <ResourceCard
          leading={<ContactAvatar contact={contact} size={28} />}
          title={fullName(contact)}
          subtitle={contact.email}
        >
          {/* Contact detail as 2-section Specsheet — who (identity) + when (timeline). */}
          <Specsheet
            sections={[
              {
                title: 'Identity',
                rows: [
                  { key: 'id', value: shortId(contact.id) },
                  { key: 'email', value: contact.email || '—' },
                  ...(contact.phone ? [{ key: 'phone', value: contact.phone }] : []),
                  ...(contact.firstName ? [{ key: 'firstName', value: contact.firstName }] : []),
                  ...(contact.lastName ? [{ key: 'lastName', value: contact.lastName }] : []),
                ],
              },
              {
                title: 'Timeline',
                rows: [
                  { key: 'created', value: formatDate(contact.cdate) },
                  { key: 'updated', value: formatDate(contact.udate) },
                ],
              },
            ]}
          />
        </ResourceCard>
      ) : null}
    </ActiveCampaignToolShell>
  );
}

function CreateContactRenderer(props: ToolCallRendererProps) {
  const parsed = props.output ? parseOutput<unknown>(props.output) : null;
  const contact = unwrap<AcContact>(parsed, 'contact');
  const input = (props.input ?? {}) as Record<string, unknown>;

  return (
    <ActiveCampaignToolShell {...props}>
      <FailedBlock error={props.status === 'failed' ? props.error : undefined} />
      {props.status === 'completed' && contact ? (
        <ResourceCard
          leading={<ContactAvatar contact={contact} size={28} />}
          title={fullName(contact)}
          subtitle={contact.email}
          verb="created"
        >
          <KeyValueGrid rows={diffFields(input, ['email', 'firstName', 'lastName', 'phone'])} />
        </ResourceCard>
      ) : null}
    </ActiveCampaignToolShell>
  );
}

function UpdateContactRenderer(props: ToolCallRendererProps) {
  const parsed = props.output ? parseOutput<unknown>(props.output) : null;
  const contact = unwrap<AcContact>(parsed, 'contact');
  const input = (props.input ?? {}) as Record<string, unknown>;
  const changes = diffFields(input, ['email', 'firstName', 'lastName', 'phone']);

  return (
    <ActiveCampaignToolShell {...props}>
      <FailedBlock error={props.status === 'failed' ? props.error : undefined} />
      {props.status === 'completed' && contact ? (
        <ResourceCard
          leading={<ContactAvatar contact={contact} size={28} />}
          title={fullName(contact)}
          subtitle={contact.email}
          verb="updated"
        >
          {changes.length > 0 ? <KeyValueGrid rows={changes} /> : null}
        </ResourceCard>
      ) : null}
    </ActiveCampaignToolShell>
  );
}

function DeleteContactRenderer(props: ToolCallRendererProps) {
  const raw = props.output ? parseOutput<{ id?: string; deleted?: boolean }>(props.output) : null;
  const parsed = raw && typeof raw === 'object' ? raw : null;
  const id = parsed?.id ?? (props.input as { id?: string })?.id ?? '';

  return (
    <ActiveCampaignToolShell {...props}>
      <FailedBlock error={props.status === 'failed' ? props.error : undefined} />
      {props.status === 'completed' && parsed?.deleted ? (
        <ResourceCard
          leading={<IconTile accent={AC_BRAND.danger} label="X" />}
          title={`Contact ${shortId(id)}`}
          subtitle="permanently deleted"
          verb="deleted"
        />
      ) : null}
    </ActiveCampaignToolShell>
  );
}

// ============================================================================
// Lists
// ============================================================================

function ListListsRenderer(props: ToolCallRendererProps) {
  const parsed = props.output ? parseOutput<unknown>(props.output) : null;
  const { items, total, nextOffset } = unwrapList<AcList>(parsed, 'lists');
  const badge =
    props.status === 'completed' ? <Badge text={`${items.length}`} variant="info" /> : undefined;

  return (
    <ActiveCampaignToolShell {...props} badge={badge}>
      <FailedBlock error={props.status === 'failed' ? props.error : undefined} />
      {props.status === 'completed' && items.length === 0 ? <Empty message="No lists" /> : null}
      {items.length > 0 ? (
        <YStack gap={4}>
          <ScrollView style={{ maxHeight: 320 }}>
            <YStack gap={2}>
              {items.map((l) => (
                <EntityRow
                  key={l.id}
                  leading={
                    <IconTile
                      accent={AC_BRAND.blue}
                      icon={<Mail size={11} color={AC_BRAND.blue} />}
                    />
                  }
                  title={l.name}
                  subtitle={l.stringid || shortId(l.id)}
                  trailing={
                    l.subscriberCount !== null ? (
                      <XStack gap={4} alignItems="center">
                        <Users size={9} color={globalColors.muted} />
                        <Text color={globalColors.muted} fontSize={9}>
                          {l.subscriberCount}
                        </Text>
                      </XStack>
                    ) : undefined
                  }
                />
              ))}
            </YStack>
          </ScrollView>
          <PaginationFooter total={total} shown={items.length} nextOffset={nextOffset} />
        </YStack>
      ) : null}
    </ActiveCampaignToolShell>
  );
}

function SubscribeContactToListRenderer(props: ToolCallRendererProps) {
  const parsed = props.output ? parseOutput<unknown>(props.output) : null;
  const cl = unwrap<AcContactList>(parsed, 'contactList');
  const status = cl?.status ?? 'subscribed';
  // Contact joins/leaves a list → member add/remove (DualAction taxonomy).
  const action = status === 'unsubscribed' ? 'remove-member' : 'add-member';

  return (
    <ActiveCampaignToolShell {...props}>
      <FailedBlock error={props.status === 'failed' ? props.error : undefined} />
      {props.status === 'completed' && cl ? (
        /* Bidirectional contact↔list operation — DualEntity preserva la dirección. */
        <DualEntity
          left={{
            title: shortId(cl.contact),
            subtitle: 'contact',
            visual: (
              <IconTile
                accent={AC_BRAND.blue}
                icon={<Users size={14} color={AC_BRAND.blue} />}
                size={28}
              />
            ),
          }}
          right={{
            title: shortId(cl.list),
            subtitle: 'list',
            visual: (
              <IconTile
                accent={status === 'subscribed' ? AC_BRAND.blue : AC_BRAND.danger}
                icon={
                  status === 'subscribed' ? (
                    <Mail size={14} color={AC_BRAND.blue} />
                  ) : (
                    <MailX size={14} color={AC_BRAND.danger} />
                  )
                }
                size={28}
              />
            ),
          }}
          action={action}
        />
      ) : null}
    </ActiveCampaignToolShell>
  );
}

// ============================================================================
// Campaigns
// ============================================================================

function campaignBadges(c: AcCampaign): React.ReactNode {
  const cs = campaignStatusChipProps(c.status);
  if (!cs) return null;
  return <IconChip {...cs} />;
}

function ListCampaignsRenderer(props: ToolCallRendererProps) {
  const parsed = props.output ? parseOutput<unknown>(props.output) : null;
  const { items, total, nextOffset } = unwrapList<AcCampaign>(parsed, 'campaigns');
  const badge =
    props.status === 'completed' ? <Badge text={`${items.length}`} variant="info" /> : undefined;

  return (
    <ActiveCampaignToolShell {...props} badge={badge}>
      <FailedBlock error={props.status === 'failed' ? props.error : undefined} />
      {props.status === 'completed' && items.length === 0 ? <Empty message="No campaigns" /> : null}
      {items.length > 0 ? (
        <YStack gap={4}>
          <ScrollView style={{ maxHeight: 360 }}>
            <YStack gap={2}>
              {items.map((c) => {
                const rate = openRate(c);
                return (
                  <EntityRow
                    key={c.id}
                    leading={
                      <IconTile
                        accent={AC_BRAND.blue}
                        icon={<Send size={11} color={AC_BRAND.blue} />}
                      />
                    }
                    title={c.name || c.subject || 'Untitled'}
                    subtitle={c.subject || '—'}
                    badges={campaignBadges(c)}
                    trailing={
                      rate ? (
                        <Text color={globalColors.muted} fontSize={9}>
                          {rate} open
                        </Text>
                      ) : undefined
                    }
                  />
                );
              })}
            </YStack>
          </ScrollView>
          <PaginationFooter total={total} shown={items.length} nextOffset={nextOffset} />
        </YStack>
      ) : null}
    </ActiveCampaignToolShell>
  );
}

function GetCampaignRenderer(props: ToolCallRendererProps) {
  const parsed = props.output ? parseOutput<unknown>(props.output) : null;
  const c = unwrap<AcCampaign>(parsed, 'campaign');

  return (
    <ActiveCampaignToolShell {...props}>
      <FailedBlock error={props.status === 'failed' ? props.error : undefined} />
      {props.status === 'completed' && c ? (
        <ResourceCard
          leading={
            <IconTile accent={AC_BRAND.blue} icon={<Send size={12} color={AC_BRAND.blue} />} />
          }
          title={c.name || 'Untitled campaign'}
          subtitle={c.subject}
          meta={campaignBadges(c)}
        >
          {/* KPIs scannables — los números que el usuario chequea de un vistazo. */}
          <MetaStrip
            items={[
              { key: 'opens', value: String(c.uniqueOpens), accent: AC_BRAND.success },
              { key: 'open rate', value: openRate(c) ?? '—' },
              { key: 'clicks', value: String(c.uniqueLinks), accent: AC_BRAND.success },
              { key: 'click rate', value: clickRate(c) ?? '—' },
              { key: 'recipients', value: String(c.totalRecipients) },
            ]}
          />
          <KeyValueGrid
            rows={[
              { key: 'id', value: shortId(c.id) },
              { key: 'type', value: c.type || '—' },
              {
                key: 'from',
                value: c.fromName ? `${c.fromName} <${c.fromEmail}>` : c.fromEmail || '—',
              },
              { key: 'sendDate', value: formatDate(c.sendDate) },
            ]}
          />
        </ResourceCard>
      ) : null}
    </ActiveCampaignToolShell>
  );
}

// ============================================================================
// Deals
// ============================================================================

function dealBadge(d: AcDeal): React.ReactNode {
  return <IconChip {...dealStatusChipProps(d.status)} />;
}

function ListDealsRenderer(props: ToolCallRendererProps) {
  const parsed = props.output ? parseOutput<unknown>(props.output) : null;
  const { items, total, nextOffset } = unwrapList<AcDeal>(parsed, 'deals');
  const badge =
    props.status === 'completed' ? <Badge text={`${items.length}`} variant="info" /> : undefined;

  return (
    <ActiveCampaignToolShell {...props} badge={badge}>
      <FailedBlock error={props.status === 'failed' ? props.error : undefined} />
      {props.status === 'completed' && items.length === 0 ? <Empty message="No deals" /> : null}
      {items.length > 0 ? (
        <YStack gap={4}>
          <ScrollView style={{ maxHeight: 360 }}>
            <YStack gap={2}>
              {items.map((d) => (
                <EntityRow
                  key={d.id}
                  leading={
                    <IconTile
                      accent={AC_BRAND.blue}
                      icon={<TrendingUp size={11} color={AC_BRAND.blue} />}
                    />
                  }
                  title={d.title || 'Untitled deal'}
                  subtitle={formatMoney(d.value, d.currency)}
                  badges={dealBadge(d)}
                />
              ))}
            </YStack>
          </ScrollView>
          <PaginationFooter total={total} shown={items.length} nextOffset={nextOffset} />
        </YStack>
      ) : null}
    </ActiveCampaignToolShell>
  );
}

function GetDealRenderer(props: ToolCallRendererProps) {
  const parsed = props.output ? parseOutput<unknown>(props.output) : null;
  const d = unwrap<AcDeal>(parsed, 'deal');

  return (
    <ActiveCampaignToolShell {...props}>
      <FailedBlock error={props.status === 'failed' ? props.error : undefined} />
      {props.status === 'completed' && d ? (
        <ResourceCard
          leading={
            <IconTile
              accent={AC_BRAND.blue}
              icon={<TrendingUp size={12} color={AC_BRAND.blue} />}
            />
          }
          title={d.title || 'Untitled deal'}
          subtitle={formatMoney(d.value, d.currency)}
          meta={dealBadge(d)}
        >
          {/* Deal detail as 3-section Specsheet — narrative flow what / where / when. */}
          <Specsheet
            sections={[
              {
                title: 'Deal',
                rows: [
                  { key: 'id', value: shortId(d.id) },
                  { key: 'value', value: formatMoney(d.value, d.currency) },
                  ...(d.description ? [{ key: 'description', value: d.description }] : []),
                ],
              },
              ...(d.contact || d.account || d.pipeline || d.stage || d.owner
                ? [
                    {
                      title: 'Context',
                      rows: [
                        ...(d.contact ? [{ key: 'contact', value: shortId(d.contact) }] : []),
                        ...(d.account ? [{ key: 'account', value: shortId(d.account) }] : []),
                        ...(d.pipeline ? [{ key: 'pipeline', value: shortId(d.pipeline) }] : []),
                        ...(d.stage ? [{ key: 'stage', value: shortId(d.stage) }] : []),
                        ...(d.owner ? [{ key: 'owner', value: shortId(d.owner) }] : []),
                      ],
                    },
                  ]
                : []),
              {
                title: 'Timeline',
                rows: [
                  { key: 'created', value: formatDate(d.cdate) },
                  { key: 'updated', value: formatDate(d.udate) },
                ],
              },
            ]}
          />
        </ResourceCard>
      ) : null}
    </ActiveCampaignToolShell>
  );
}

function CreateDealRenderer(props: ToolCallRendererProps) {
  const parsed = props.output ? parseOutput<unknown>(props.output) : null;
  const d = unwrap<AcDeal>(parsed, 'deal');
  const input = (props.input ?? {}) as Record<string, unknown>;

  return (
    <ActiveCampaignToolShell {...props}>
      <FailedBlock error={props.status === 'failed' ? props.error : undefined} />
      {props.status === 'completed' && d ? (
        <ResourceCard
          leading={
            <IconTile
              accent={AC_BRAND.blue}
              icon={<TrendingUp size={12} color={AC_BRAND.blue} />}
            />
          }
          title={d.title}
          subtitle={formatMoney(d.value, d.currency)}
          meta={dealBadge(d)}
          verb="created"
        >
          <KeyValueGrid
            rows={diffFields(input, [
              'title',
              'value',
              'currency',
              'pipelineId',
              'stageId',
              'ownerId',
              'contactId',
              'description',
            ])}
          />
        </ResourceCard>
      ) : null}
    </ActiveCampaignToolShell>
  );
}

// ============================================================================
// Tags
// ============================================================================

function ListTagsRenderer(props: ToolCallRendererProps) {
  const parsed = props.output ? parseOutput<unknown>(props.output) : null;
  const { items, total, nextOffset } = unwrapList<AcTag>(parsed, 'tags');
  const badge =
    props.status === 'completed' ? <Badge text={`${items.length}`} variant="info" /> : undefined;

  return (
    <ActiveCampaignToolShell {...props} badge={badge}>
      <FailedBlock error={props.status === 'failed' ? props.error : undefined} />
      {props.status === 'completed' && items.length === 0 ? <Empty message="No tags" /> : null}
      {items.length > 0 ? (
        <YStack gap={4}>
          <PillList items={items.map((t) => t.name)} max={items.length} accent={AC_BRAND.blue} />
          <PaginationFooter total={total} shown={items.length} nextOffset={nextOffset} />
        </YStack>
      ) : null}
    </ActiveCampaignToolShell>
  );
}

function AddTagToContactRenderer(props: ToolCallRendererProps) {
  const parsed = props.output ? parseOutput<unknown>(props.output) : null;
  const ct = unwrap<AcContactTag>(parsed, 'contactTag');

  return (
    <ActiveCampaignToolShell {...props}>
      <FailedBlock error={props.status === 'failed' ? props.error : undefined} />
      {props.status === 'completed' && ct ? (
        /* Bidirectional operation contact↔tag — primitivo canónico v2 §6. */
        <DualEntity
          left={{
            title: shortId(ct.contact),
            subtitle: 'contact',
            visual: (
              <IconTile
                accent={AC_BRAND.blue}
                icon={<Users size={14} color={AC_BRAND.blue} />}
                size={28}
              />
            ),
          }}
          right={{
            title: shortId(ct.tag),
            subtitle: 'tag',
            visual: (
              <IconTile
                accent={AC_BRAND.blue}
                icon={<Tag size={14} color={AC_BRAND.blue} />}
                size={28}
              />
            ),
          }}
          action="grant"
        />
      ) : null}
    </ActiveCampaignToolShell>
  );
}

// ============================================================================
// Registry — 15/15 coverage
// ============================================================================

const RENDERERS: Record<string, React.ComponentType<ToolCallRendererProps>> = {
  '-health-check': HealthCheckRenderer,
  // Contacts
  'list-contacts': ListContactsRenderer,
  'get-contact': GetContactRenderer,
  'create-contact': CreateContactRenderer,
  'update-contact': UpdateContactRenderer,
  'delete-contact': DeleteContactRenderer,
  // Lists
  'list-lists': ListListsRenderer,
  'subscribe-contact-to-list': SubscribeContactToListRenderer,
  // Campaigns
  'list-campaigns': ListCampaignsRenderer,
  'get-campaign': GetCampaignRenderer,
  // Deals
  'list-deals': ListDealsRenderer,
  'get-deal': GetDealRenderer,
  'create-deal': CreateDealRenderer,
  // Tags
  'list-tags': ListTagsRenderer,
  'add-tag-to-contact': AddTagToContactRenderer,
};

// ============================================================================
// FallbackRenderer — dev-only warning
// ============================================================================

function FallbackRenderer({ toolName, status, output, error }: ToolCallRendererProps) {
  const shortName = getShortToolName(toolName);

  const badge = __DEV__ ? (
    <Badge text="no renderer" variant="error" />
  ) : status === 'completed' ? (
    <Badge text="done" variant="success" />
  ) : status === 'failed' ? (
    <Badge text="failed" variant="error" />
  ) : null;

  return (
    <ToolCallCard
      status={toolStatusForPrimitive(status)}
      description={getToolLabel(toolName)}
      badge={badge}
      defaultExpanded={__DEV__}
    >
      {__DEV__ && (
        <YStack
          backgroundColor={indicators.irreversible.bg}
          borderRadius={5}
          padding={8}
          borderWidth={1}
          borderColor={indicators.irreversible.border}
          gap={2}
        >
          <Text color={globalColors.badgeError.text} fontSize={10} fontWeight="600">
            [dev] Missing sub-renderer for "{shortName}"
          </Text>
          <Text color={globalColors.secondary} fontSize={9}>
            Register it in the RENDERERS map in ActiveCampaignRenderer.tsx.
          </Text>
        </YStack>
      )}
      {output && <JsonPreview value={output} />}
      {error && <ErrorBlock error={error} />}
    </ToolCallCard>
  );
}

// ============================================================================
// Entry point
// ============================================================================

function ActiveCampaignRendererBase(props: ToolCallRendererProps) {
  const shortName = getShortToolName(props.toolName);
  const Renderer = RENDERERS[shortName] ?? FallbackRenderer;
  return <Renderer {...props} />;
}

export const ActiveCampaignToolCallRenderer = withPermissionSupport(ActiveCampaignRendererBase);
export default ActiveCampaignToolCallRenderer;
