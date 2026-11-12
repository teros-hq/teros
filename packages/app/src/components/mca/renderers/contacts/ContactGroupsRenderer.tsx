/**
 * Google Contacts Renderer - Contact Group Operations
 *
 * Renderers for the 7 contact-group tools of mca.google.contacts
 * (list/get/create/update/delete group, add/remove contacts to group).
 *
 * Output shapes verified against the MCA source (src/tools/*.ts, 2026-10-06):
 *   list-contact-groups   → { groups[], totalItems?, nextPageToken? }
 *   get-contact-group     → { resourceName, name, formattedName?, groupType?,
 *                            memberCount?, memberResourceNames[] }
 *   create-contact-group  → { success, resourceName, name, formattedName?, groupType? }
 *   update-contact-group  → { success, resourceName, name, formattedName?, groupType? }
 *   delete-contact-group  → { success, message, contactsDeleted }
 *   add-contacts-to-group    → { success, message, notFoundResourceNames[], canNotAddResourceNames[] }
 *   remove-contacts-from-group → { success, message, notFoundResourceNames[] }
 */

import { Tag, Users } from '../../primitives';
import type React from 'react';
import { ScrollView, Text, XStack, YStack } from 'tamagui';

import { countBadgeVariant, formatCountBadge } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import {
  Badge,
  DualEntity,
  Empty,
  EntityRow,
  ErrorBlock,
  IconTile,
  ResourceCard,
  SuccessBlock,
  ToolCallCard,
} from '../../primitives';
import { parseOutput, useContactsColors } from './shared';

// ============================================================================
// Types — shapes from the MCA handlers
// ============================================================================

interface ContactGroup {
  resourceName?: string;
  name?: string;
  formattedName?: string;
  groupType?: string;
  memberCount?: number;
}

interface ListGroupsResult {
  groups?: ContactGroup[];
  totalItems?: number;
  nextPageToken?: string;
}

interface GetGroupResult extends ContactGroup {
  memberResourceNames?: string[];
}

interface MutationResult {
  success?: boolean;
  message?: string;
  contactsDeleted?: boolean;
  notFoundResourceNames?: string[];
  canNotAddResourceNames?: string[];
}

// ============================================================================
// Helpers
// ============================================================================

function isResultError(result: unknown): boolean {
  return typeof result === 'string' && result.toLowerCase().includes('error');
}

/** Group name with fallback to the resourceName tail. */
function groupLabel(group: {
  name?: string;
  formattedName?: string;
  resourceName?: string;
}): string {
  return group.name ?? group.formattedName ?? group.resourceName?.split('/').pop() ?? 'Unnamed group';
}

/** Leading visual for a group row — a tag tile, per the label semantics. */
function groupTile(): React.ReactNode {
  return <IconTile icon={<Tag size={14} color="#1a73e8" />} size={24} accent="#1a73e8" />;
}

// ============================================================================
// list-contact-groups — pattern A (EntityRow list)
// ============================================================================

export function ListContactGroupsRenderer({
  status,
  output,
  error,
  appIcon,
}: ToolCallRendererProps) {
  const c = useContactsColors();
  const result = output ? parseOutput<ListGroupsResult>(output) : null;
  const isError = isResultError(result);
  const groups = result && typeof result === 'object' ? (result.groups ?? []) : [];

  let badge: React.ReactNode = null;
  if (status === 'pending_permission') {
    badge = <Badge text="awaiting" variant="warning" />;
  } else if (status === 'completed' && result && typeof result === 'object') {
    const total = result.totalItems ?? groups.length;
    badge = <Badge text={formatCountBadge(total, 'group')} variant={countBadgeVariant(total)} />;
  } else if (status === 'failed' || isError) {
    badge = <Badge text="failed" variant="error" />;
  }

  const description =
    status === 'failed'
      ? 'Failed to list groups'
      : status === 'completed'
        ? `Listed ${groups.length} groups`
        : 'List groups';

  return (
    <ToolCallCard
      status={status}
      description={description}
      badge={badge}
      iconUri={appIcon}
    >
      {isError && <ErrorBlock error={result as string} />}
      {status === 'failed' && error && <ErrorBlock error={error} />}
      {result && typeof result === 'object' && (
        <YStack gap={4} maxHeight={300}>
          {groups.length === 0 ? (
            <Empty message="No contact groups found" hint="Create one with create-contact-group" />
          ) : (
            <ScrollView>
              <YStack>
                {groups.slice(0, 50).map((group, idx) => (
                  <EntityRow
                    key={group.resourceName ?? `group-${idx}`}
                    leading={groupTile()}
                    title={groupLabel(group)}
                    subtitle={group.resourceName}
                    badges={
                      <>
                        {group.groupType ? <Badge text={group.groupType} variant="gray" /> : null}
                        {typeof group.memberCount === 'number' && group.memberCount > 0 ? (
                          <Badge
                            text={formatCountBadge(group.memberCount, 'member')}
                            variant="info"
                          />
                        ) : null}
                      </>
                    }
                  />
                ))}
                {groups.length > 50 && (
                  <Text color={c.text3} fontSize={10} textAlign="center" paddingVertical={4}>
                    +{groups.length - 50} more groups
                  </Text>
                )}
              </YStack>
            </ScrollView>
          )}
          {result.nextPageToken && (
            <XStack justifyContent="center">
              <Badge text="more available" variant="gray" />
            </XStack>
          )}
        </YStack>
      )}
    </ToolCallCard>
  );
}

// ============================================================================
// get-contact-group — pattern B (ResourceCard detail)
// ============================================================================

export function GetContactGroupRenderer({
  status,
  output,
  error,
  appIcon,
}: ToolCallRendererProps) {
  const c = useContactsColors();
  const result = output ? parseOutput<GetGroupResult>(output) : null;
  const isError = isResultError(result);
  const group = result && typeof result === 'object' ? (result as GetGroupResult) : null;

  let badge: React.ReactNode = null;
  if (status === 'pending_permission') {
    badge = <Badge text="awaiting" variant="warning" />;
  } else if (status === 'completed' && group) {
    badge = <Badge text="found" variant="success" />;
  } else if (status === 'failed' || isError) {
    badge = <Badge text="failed" variant="error" />;
  }

  const description =
    status === 'failed'
      ? 'Failed to get group'
      : status === 'completed' && group
        ? groupLabel(group)
        : 'Get group';

  return (
    <ToolCallCard
      status={status}
      description={description}
      badge={badge}
      iconUri={appIcon}
    >
      {isError && <ErrorBlock error={result as string} />}
      {status === 'failed' && error && <ErrorBlock error={error} />}
      {group && (
        <ResourceCard leading={groupTile()} title={groupLabel(group)} subtitle={group.resourceName}>
          <XStack gap={6} flexWrap="wrap">
            {group.groupType ? <Badge text={group.groupType} variant="gray" /> : null}
            <Badge
              text={formatCountBadge(group.memberCount ?? 0, 'member')}
              variant={countBadgeVariant(group.memberCount ?? 0)}
            />
          </XStack>
          {group.memberResourceNames && group.memberResourceNames.length > 0 && (
            <YStack gap={2}>
              <Text color={c.text3} fontSize={9} fontFamily="$mono">
                MEMBERS
              </Text>
              {group.memberResourceNames.slice(0, 20).map((member, idx) => (
                <Text key={`${member}-${idx}`} color={c.text2} fontSize={10} fontFamily="$mono">
                  {member}
                </Text>
              ))}
              {group.memberResourceNames.length > 20 && (
                <Text color={c.text3} fontSize={9} fontFamily="$mono">
                  +{group.memberResourceNames.length - 20} more
                </Text>
              )}
            </YStack>
          )}
        </ResourceCard>
      )}
    </ToolCallCard>
  );
}

// ============================================================================
// create-contact-group — pattern C (ResourceCard + verb)
// ============================================================================

export function CreateContactGroupRenderer({
  input,
  status,
  output,
  error,
  appIcon,
}: ToolCallRendererProps) {
  const result = output ? parseOutput<ContactGroup & MutationResult>(output) : null;
  const isError = isResultError(result);
  const group =
    result && typeof result === 'object' ? (result as ContactGroup & MutationResult) : null;
  const inputName = typeof input?.name === 'string' ? input.name : '';

  let badge: React.ReactNode = null;
  if (status === 'pending_permission') {
    badge = <Badge text="awaiting" variant="warning" />;
  } else if (status === 'completed' && group) {
    badge = <Badge text="created" variant="success" />;
  } else if (status === 'failed' || isError) {
    badge = <Badge text="failed" variant="error" />;
  }

  const description =
    status === 'failed'
      ? 'Failed to create group'
      : status === 'completed' && group
        ? `Created group "${groupLabel(group)}"`
        : inputName
          ? `Create group "${inputName}"`
          : 'Create group';

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
      {isError && <ErrorBlock error={result as string} />}
      {status === 'failed' && error && <ErrorBlock error={error} />}
      {group && (
        <ResourceCard
          leading={groupTile()}
          title={groupLabel(group)}
          subtitle={group.resourceName}
          verb="created"
        />
      )}
      {status === 'completed' && group && (
        <SuccessBlock message={`Group "${groupLabel(group)}" created`} />
      )}
    </ToolCallCard>
  );
}

// ============================================================================
// update-contact-group — pattern C (ResourceCard + verb + new name)
// ============================================================================

export function UpdateContactGroupRenderer({
  input,
  status,
  output,
  error,
  appIcon,
}: ToolCallRendererProps) {
  const c = useContactsColors();
  const result = output ? parseOutput<ContactGroup & MutationResult>(output) : null;
  const isError = isResultError(result);
  const group =
    result && typeof result === 'object' ? (result as ContactGroup & MutationResult) : null;
  const inputName = typeof input?.name === 'string' ? input.name : '';
  const resourceName = typeof input?.resourceName === 'string' ? input.resourceName : '';

  let badge: React.ReactNode = null;
  if (status === 'pending_permission') {
    badge = <Badge text="awaiting" variant="warning" />;
  } else if (status === 'completed' && group) {
    badge = <Badge text="renamed" variant="success" />;
  } else if (status === 'failed' || isError) {
    badge = <Badge text="failed" variant="error" />;
  }

  const description =
    status === 'failed'
      ? 'Failed to rename group'
      : status === 'completed' && group
        ? `Renamed to "${groupLabel(group)}"`
        : inputName
          ? `Rename group to "${inputName}"`
          : 'Rename group';

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
      {isError && <ErrorBlock error={result as string} />}
      {status === 'failed' && error && <ErrorBlock error={error} />}
      {group && (
        <ResourceCard
          leading={groupTile()}
          title={groupLabel(group)}
          subtitle={group.resourceName ?? resourceName}
          verb="renamed"
        >
          {inputName ? (
            <Text color={c.text2} fontSize={10}>
              New name: {inputName}
            </Text>
          ) : null}
        </ResourceCard>
      )}
      {status === 'completed' && group && (
        <SuccessBlock message={`Group renamed to "${groupLabel(group)}"`} />
      )}
    </ToolCallCard>
  );
}

// ============================================================================
// delete-contact-group — pattern C (compact + irreversible)
// ============================================================================

export function DeleteContactGroupRenderer({
  input,
  status,
  output,
  error,
  appIcon,
}: ToolCallRendererProps) {
  const result = output ? parseOutput<MutationResult>(output) : null;
  const isError = isResultError(result);
  const mutation = result && typeof result === 'object' ? (result as MutationResult) : null;
  const deleteContacts = input?.deleteContacts === true;

  let badge: React.ReactNode = null;
  if (status === 'pending_permission') {
    badge = <Badge text="awaiting" variant="warning" />;
  } else if (status === 'completed' && !isError) {
    badge = <Badge text="deleted" variant="error" />;
  } else if (status === 'failed' || isError) {
    badge = <Badge text="failed" variant="error" />;
  }

  const description =
    status === 'failed'
      ? 'Failed to delete group'
      : deleteContacts
        ? 'Delete group + contacts'
        : 'Delete group';

  return (
    <ToolCallCard
      status={status}
      description={description}
      badge={badge}
      iconUri={appIcon}
      irreversible
    >
      {isError && <ErrorBlock error={result as string} />}
      {status === 'failed' && error && <ErrorBlock error={error} />}
      {status === 'completed' && mutation && !isError && (
        <SuccessBlock
          message={
            mutation.contactsDeleted
              ? 'Group and its contacts deleted'
              : 'Group deleted (contacts kept)'
          }
        />
      )}
    </ToolCallCard>
  );
}

// ============================================================================
// add-contacts-to-group / remove-contacts-from-group — pattern D (DualEntity)
// ============================================================================

interface GroupMembershipRendererProps extends ToolCallRendererProps {
  /** 'add' | 'remove' — selects the DualEntity action and copy. */
  mode: 'add' | 'remove';
}

function GroupMembershipRenderer({
  mode,
  input,
  status,
  output,
  error,
  appIcon,
}: GroupMembershipRendererProps) {
  const result = output ? parseOutput<MutationResult>(output) : null;
  const isError = isResultError(result);
  const mutation = result && typeof result === 'object' ? (result as MutationResult) : null;

  const groupName = typeof input?.resourceName === 'string' ? input.resourceName : '';
  const contactNames = Array.isArray(input?.contactResourceNames)
    ? (input?.contactResourceNames as string[])
    : [];

  const action = mode === 'add' ? ('add-member' as const) : ('remove-member' as const);

  let badge: React.ReactNode = null;
  if (status === 'pending_permission') {
    badge = <Badge text="awaiting" variant="warning" />;
  } else if (status === 'completed' && !isError) {
    badge = <Badge text={formatCountBadge(contactNames.length, 'contact')} variant="success" />;
  } else if (status === 'failed' || isError) {
    badge = <Badge text="failed" variant="error" />;
  }

  const description =
    status === 'failed'
      ? mode === 'add'
        ? 'Failed to add contacts to group'
        : 'Failed to remove contacts from group'
      : mode === 'add'
        ? `Add ${contactNames.length} contact(s) to group`
        : `Remove ${contactNames.length} contact(s) from group`;

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
      {isError && <ErrorBlock error={result as string} />}
      {status === 'failed' && error && <ErrorBlock error={error} />}
      {contactNames.length > 0 && (
        <DualEntity
          left={{
            visual: (
              <IconTile icon={<Users size={14} color="#1a73e8" />} size={24} accent="#1a73e8" />
            ),
            title:
              contactNames.length === 1 ? contactNames[0] : `${contactNames.length} contacts`,
            subtitle: contactNames.length === 1 ? undefined : contactNames.slice(0, 3).join(', '),
          }}
          right={{
            visual: groupTile(),
            title: groupName ? (groupName.split('/').pop() ?? groupName) : 'group',
            subtitle: groupName,
          }}
          action={action}
          meta={mode === 'add' ? 'add to group' : 'remove from group'}
        />
      )}
      {status === 'completed' && mutation && !isError && (
        <SuccessBlock
          message={
            mutation.message ?? (mode === 'add'
              ? 'Contacts added to group'
              : 'Contacts removed from group')
          }
        />
      )}
      {status === 'completed' && mutation && !isError && (
        <YStack gap={2}>
          {mutation.notFoundResourceNames && mutation.notFoundResourceNames.length > 0 && (
            <Text color="#8a8a8a" fontSize={9} fontFamily="$mono">
              not found: {mutation.notFoundResourceNames.join(', ')}
            </Text>
          )}
          {mode === 'add' &&
            mutation.canNotAddResourceNames &&
            mutation.canNotAddResourceNames.length > 0 && (
              <Text color="#8a8a8a" fontSize={9} fontFamily="$mono">
                could not add: {mutation.canNotAddResourceNames.join(', ')}
              </Text>
            )}
        </YStack>
      )}
    </ToolCallCard>
  );
}

export function AddContactsToGroupRenderer(props: ToolCallRendererProps) {
  return <GroupMembershipRenderer mode="add" {...props} />;
}

export function RemoveContactsFromGroupRenderer(props: ToolCallRendererProps) {
  return <GroupMembershipRenderer mode="remove" {...props} />;
}
