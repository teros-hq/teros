/**
 * Google Contacts Renderer - Contact Operations
 *
 * Renderers for list, get, search, create, update, delete contacts.
 *
 * Input/output shapes verified against the MCA source (src/tools/*.ts,
 * 2026-10-06) — the 2026-10 rename also changed shapes:
 *   - create/update-contact take `givenName`/`familyName` (NOT `name`), and
 *     update has no `notes` param.
 *   - create/update-contact return `{ success, resourceName, name }`.
 *   - get-contact returns `organizations[{name,title}]`, `biographies[]`,
 *     `addresses[{formattedValue,…}]` — normalized below into the `Contact`
 *     shape the rows consume.
 *   - list-contacts has NO `query` param (only pageSize/pageToken).
 */

import { Building2, FileText, Mail, MapPin, Phone } from '../../primitives';
import type React from 'react';
import { Linking } from 'react-native';
import { ScrollView, Text, XStack, YStack } from 'tamagui';

import { countBadgeVariant, formatCountBadge } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { ErrorBlock, KeyValueGrid, SuccessBlock, ToolCallCard } from '../../primitives';
import {
  Badge,
  type Contact,
  ContactAvatar,
  ContactDetailRow,
  ContactRow,
  getDisplayName,
  getFieldValue,
  parseOutput,
  useContactsColors,
} from './shared';

// ============================================================================
// Types — raw output shapes from the MCA handlers
// ============================================================================

interface ListContactsResult {
  contacts: Contact[];
  totalItems?: number;
  nextPageToken?: string;
}

interface SearchContactsResult {
  contacts: Contact[];
}

/** get-contact raw output — richer than the shared `Contact` row shape. */
interface GetContactOutput {
  resourceName?: string;
  name?: string;
  givenName?: string;
  familyName?: string;
  emails?: Array<{ value?: string; type?: string }>;
  phones?: Array<{ value?: string; type?: string }>;
  organizations?: Array<{ name?: string; title?: string }>;
  addresses?: Array<{ formattedValue?: string; type?: string; city?: string; country?: string }>;
  biographies?: string[];
  photo?: string;
}

/** create/update-contact output. */
interface MutationOutput {
  success?: boolean;
  message?: string;
  resourceName?: string;
  name?: string;
}

interface DeleteResult {
  success?: boolean;
  message?: string;
}

// ============================================================================
// Helpers
// ============================================================================

function isResultError(result: unknown): boolean {
  return typeof result === 'string' && result.toLowerCase().includes('error');
}

/** `givenName`/`familyName` input → display name (schema has no `name`). */
function inputContactName(input: Record<string, any> | undefined): string {
  const given = typeof input?.givenName === 'string' ? input.givenName : '';
  const family = typeof input?.familyName === 'string' ? input.familyName : '';
  return `${given} ${family}`.trim();
}

/** Normalizes get-contact's richer output into the shared `Contact` shape. */
function toContact(raw: GetContactOutput): Contact {
  return {
    resourceName: raw.resourceName ?? '',
    name: raw.name,
    givenName: raw.givenName,
    familyName: raw.familyName,
    emails: raw.emails?.map((e) => ({ value: e.value ?? '', type: e.type })),
    phones: raw.phones?.map((p) => ({ value: p.value ?? '', type: p.type })),
    organization: raw.organizations?.[0]?.name,
    title: raw.organizations?.[0]?.title,
    photo: raw.photo,
    addresses: raw.addresses?.map((a) => ({ value: a.formattedValue ?? '', type: a.type })),
    notes: raw.biographies?.[0],
  };
}

// ============================================================================
// List Contacts Renderer
// ============================================================================

export function ListContactsRenderer({
  status,
  output,
  error,
  input,
  appIcon,
}: ToolCallRendererProps) {
  const c = useContactsColors();

  const result = output ? parseOutput<ListContactsResult>(output) : null;
  const isError = isResultError(result);

  let badge: React.ReactNode = null;
  const count =
    status === 'completed' && result && typeof result === 'object'
      ? (result.contacts?.length ?? 0)
      : 0;

  const description =
    status === 'failed'
      ? 'Failed to list contacts'
      : status === 'completed'
        ? `Listed ${count} contacts`
        : 'List contacts';

  if (status === 'pending_permission') {
    badge = <Badge text="awaiting" variant="warning" />;
  } else if (status === 'completed' && result && typeof result === 'object') {
    const total = result.totalItems;
    const text = total ? `${count}/${total}` : formatCountBadge(count, 'contact');
    badge = <Badge text={text} variant={countBadgeVariant(count)} />;
  } else if (status === 'failed' || isError) {
    badge = <Badge text="failed" variant="error" />;
  }

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
      {status === 'pending_permission' && input && (
        <KeyValueGrid
          rows={[
            // list-contacts has no `query` param — only pageSize/pageToken.
            ...(input.pageSize ? [{ key: 'Page size', value: String(input.pageSize) }] : []),
            ...(input.pageToken ? [{ key: 'Page token', value: String(input.pageToken), mono: true }] : []),
          ]}
        />
      )}
      {isError && <ErrorBlock error={result as string} />}
      {status === 'failed' && error && <ErrorBlock error={error} />}
      {result && typeof result === 'object' && result.contacts && (
        <YStack gap={4} maxHeight={300}>
          <ScrollView>
            <YStack gap={4}>
              {result.contacts.slice(0, 20).map((contact, idx) => (
                <ContactRow key={contact.resourceName || idx} contact={contact} showDetails />
              ))}
              {result.contacts.length > 20 && (
                <Text color={c.text3} fontSize={10} textAlign="center" paddingVertical={4}>
                  +{result.contacts.length - 20} more contacts
                </Text>
              )}
            </YStack>
          </ScrollView>
        </YStack>
      )}
      {result && typeof result === 'object' && result.nextPageToken && (
        <XStack justifyContent="center">
          <Badge text="more available" variant="gray" />
        </XStack>
      )}
    </ToolCallCard>
  );
}

// ============================================================================
// Get Contact Renderer
// ============================================================================

export function GetContactRenderer({ status, output, error, input, appIcon }: ToolCallRendererProps) {
  const c = useContactsColors();

  const result = output ? parseOutput<GetContactOutput>(output) : null;
  const isError = isResultError(result);
  const resourceName = typeof input?.resourceName === 'string' ? input.resourceName : '';
  const contact = result && typeof result === 'object' ? toContact(result) : null;

  let badge: React.ReactNode = null;
  const completedName = contact ? getDisplayName(contact) : '';

  const description =
    status === 'failed'
      ? 'Failed to get contact'
      : status === 'completed'
        ? completedName || 'Got contact'
        : 'Get contact';

  if (status === 'pending_permission') {
    badge = <Badge text="awaiting" variant="warning" />;
  } else if (status === 'completed' && contact) {
    badge = <Badge text="found" variant="success" />;
  } else if (status === 'failed' || isError) {
    badge = <Badge text="failed" variant="error" />;
  }

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
      {status === 'pending_permission' && resourceName && (
        <KeyValueGrid rows={[{ key: 'Contact', value: resourceName, mono: true }]} />
      )}
      {isError && <ErrorBlock error={result as string} />}
      {status === 'failed' && error && <ErrorBlock error={error} />}
      {contact && (
        <YStack gap={8}>
          <XStack
            alignItems="center"
            gap={12}
            paddingBottom={8}
            borderBottomWidth={1}
            borderBottomColor={c.border}
          >
            <ContactAvatar contact={contact} size={48} />
            <YStack flex={1}>
              <Text color={c.text} fontSize={14} fontWeight="600">
                {getDisplayName(contact)}
              </Text>
              {contact.title && contact.organization && (
                <Text color={c.text2} fontSize={11}>
                  {contact.title} at {contact.organization}
                </Text>
              )}
            </YStack>
          </XStack>
          <YStack gap={4}>
            {contact.emails?.map((email, idx) => {
              const emailValue = getFieldValue(email);
              return (
                <ContactDetailRow
                  key={`email-${idx}`}
                  icon={Mail}
                  label={idx === 0 ? 'Email' : `Email ${idx + 1}`}
                  value={emailValue}
                  onPress={() => Linking.openURL(`mailto:${emailValue}`)}
                />
              );
            })}
            {contact.phones?.map((phone, idx) => {
              const phoneValue = getFieldValue(phone);
              return (
                <ContactDetailRow
                  key={`phone-${idx}`}
                  icon={Phone}
                  label={idx === 0 ? 'Phone' : `Phone ${idx + 1}`}
                  value={phoneValue}
                  onPress={() => Linking.openURL(`tel:${phoneValue}`)}
                />
              );
            })}
            {contact.organization && (
              <ContactDetailRow
                icon={Building2}
                label="Organization"
                value={contact.organization}
              />
            )}
            {contact.addresses?.map((address, idx) => (
              <ContactDetailRow
                key={`addr-${idx}`}
                icon={MapPin}
                label={idx === 0 ? 'Address' : `Address ${idx + 1}`}
                value={getFieldValue(address)}
              />
            ))}
            {contact.notes && (
              <ContactDetailRow icon={FileText} label="Notes" value={contact.notes} />
            )}
          </YStack>
        </YStack>
      )}
    </ToolCallCard>
  );
}

// ============================================================================
// Search Contacts Renderer
// ============================================================================

export function SearchContactsRenderer({
  status,
  output,
  error,
  input,
  appIcon,
}: ToolCallRendererProps) {
  const c = useContactsColors();

  const result = output ? parseOutput<SearchContactsResult>(output) : null;
  const isError = isResultError(result);
  const query = typeof input?.query === 'string' ? input.query : '';

  let badge: React.ReactNode = null;
  const searchCount =
    status === 'completed' && result && typeof result === 'object'
      ? (result.contacts?.length ?? 0)
      : 0;

  const description =
    status === 'failed'
      ? query
        ? `Failed to search "${query}"`
        : 'Failed to search contacts'
      : query
        ? `Search "${query}"`
        : 'Searched contacts';

  if (status === 'pending_permission') {
    badge = <Badge text="awaiting" variant="warning" />;
  } else if (status === 'completed' && result && typeof result === 'object') {
    badge = <Badge text={formatCountBadge(searchCount, 'result')} variant={countBadgeVariant(searchCount)} />;
  } else if (status === 'failed' || isError) {
    badge = <Badge text="failed" variant="error" />;
  }

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
      {status === 'pending_permission' && query && (
        <KeyValueGrid rows={[{ key: 'Query', value: query }]} />
      )}
      {isError && <ErrorBlock error={result as string} />}
      {status === 'failed' && error && <ErrorBlock error={error} />}
      {result && typeof result === 'object' && result.contacts && (
        <YStack gap={4} maxHeight={250}>
          <ScrollView>
            <YStack gap={4}>
              {result.contacts.length === 0 ? (
                <Text color={c.text3} fontSize={11} textAlign="center" paddingVertical={8}>
                  No contacts found
                </Text>
              ) : (
                result.contacts.map((contact, idx) => (
                  <ContactRow key={contact.resourceName || idx} contact={contact} showDetails />
                ))
              )}
            </YStack>
          </ScrollView>
        </YStack>
      )}
    </ToolCallCard>
  );
}

// ============================================================================
// Create Contact Renderer
// ============================================================================

export function CreateContactRenderer({
  status,
  output,
  error,
  input,
  appIcon,
}: ToolCallRendererProps) {
  const result = output ? parseOutput<MutationOutput>(output) : null;
  const isError = isResultError(result);
  const mutation = result && typeof result === 'object' ? (result as MutationOutput) : null;

  // Schema fields: givenName/familyName (no `name`), email, phone,
  // organization, title, notes.
  const inputName = inputContactName(input);
  const inputEmail = typeof input?.email === 'string' ? input.email : '';
  const inputPhone = typeof input?.phone === 'string' ? input.phone : '';
  const inputOrg = typeof input?.organization === 'string' ? input.organization : '';

  let badge: React.ReactNode = null;
  const completedName = mutation?.name ?? mutation?.resourceName ?? '';

  const description =
    status === 'failed'
      ? 'Failed to create contact'
      : status === 'completed' && completedName
        ? `Created: ${completedName}`
        : inputName
          ? `Create contact "${inputName}"`
          : 'Create contact';

  if (status === 'pending_permission') {
    badge = <Badge text="awaiting" variant="warning" />;
  } else if (status === 'completed' && mutation && !isError) {
    badge = <Badge text="created" variant="success" />;
  } else if (status === 'failed' || isError) {
    badge = <Badge text="failed" variant="error" />;
  }

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
      {status === 'pending_permission' && (
        <KeyValueGrid
          rows={[
            ...(inputName ? [{ key: 'Name', value: inputName }] : []),
            ...(inputEmail ? [{ key: 'Email', value: inputEmail }] : []),
            ...(inputPhone ? [{ key: 'Phone', value: inputPhone }] : []),
            ...(inputOrg ? [{ key: 'Organization', value: inputOrg }] : []),
            ...(input?.notes ? [{ key: 'Notes', value: String(input.notes) }] : []),
          ]}
        />
      )}
      {isError && <ErrorBlock error={result as string} />}
      {status === 'failed' && error && <ErrorBlock error={error} />}
      {status === 'completed' && mutation && !isError && (
        <SuccessBlock
          message={`Contact "${completedName || inputName || 'created'}" created successfully`}
        />
      )}
    </ToolCallCard>
  );
}

// ============================================================================
// Update Contact Renderer
// ============================================================================

export function UpdateContactRenderer({
  status,
  output,
  error,
  input,
  appIcon,
}: ToolCallRendererProps) {
  const result = output ? parseOutput<MutationOutput>(output) : null;
  const isError = isResultError(result);
  const mutation = result && typeof result === 'object' ? (result as MutationOutput) : null;

  const resourceName = typeof input?.resourceName === 'string' ? input.resourceName : '';

  // Schema fields: resourceName, givenName/familyName (no `name`), email,
  // phone, organization, title — update-contact has NO `notes` param.
  const updateFields: Array<{ key: string; value: string }> = [];
  if (resourceName) updateFields.push({ key: 'Contact', value: resourceName });
  const inputName = inputContactName(input);
  if (inputName) updateFields.push({ key: 'Name', value: inputName });
  if (typeof input?.email === 'string' && input.email) updateFields.push({ key: 'Email', value: input.email });
  if (typeof input?.phone === 'string' && input.phone) updateFields.push({ key: 'Phone', value: input.phone });
  if (typeof input?.organization === 'string' && input.organization) updateFields.push({ key: 'Organization', value: input.organization });
  if (typeof input?.title === 'string' && input.title) updateFields.push({ key: 'Title', value: input.title });

  let badge: React.ReactNode = null;
  const completedName = mutation?.name ?? mutation?.resourceName ?? '';

  const description =
    status === 'failed'
      ? 'Failed to update contact'
      : status === 'completed' && completedName
        ? `Updated: ${completedName}`
        : 'Update contact';

  if (status === 'pending_permission') {
    badge = <Badge text="awaiting" variant="warning" />;
  } else if (status === 'completed' && mutation?.success === false) {
    badge = <Badge text="no changes" variant="warning" />;
  } else if (status === 'completed' && mutation && !isError) {
    badge = <Badge text="updated" variant="success" />;
  } else if (status === 'failed' || isError) {
    badge = <Badge text="failed" variant="error" />;
  }

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
      {status === 'pending_permission' && updateFields.length > 0 && (
        <KeyValueGrid rows={updateFields} />
      )}
      {isError && <ErrorBlock error={result as string} />}
      {status === 'failed' && error && <ErrorBlock error={error} />}
      {status === 'completed' && mutation?.success === false && mutation.message && (
        <ErrorBlock error={mutation.message} />
      )}
      {status === 'completed' && mutation && mutation.success !== false && !isError && (
        <SuccessBlock
          message={`Contact "${completedName || resourceName || 'updated'}" updated successfully`}
        />
      )}
    </ToolCallCard>
  );
}

// ============================================================================
// Delete Contact Renderer
// ============================================================================

export function DeleteContactRenderer({
  status,
  output,
  error,
  input,
  appIcon,
}: ToolCallRendererProps) {
  const result = output ? parseOutput<DeleteResult>(output) : null;
  const isError = isResultError(result);

  const resourceName = typeof input?.resourceName === 'string' ? input.resourceName : '';

  let badge: React.ReactNode = null;

  const description =
    status === 'failed'
      ? 'Failed to delete contact'
      : status === 'completed'
        ? 'Contact deleted'
        : 'Delete contact';

  if (status === 'pending_permission') {
    badge = <Badge text="awaiting" variant="warning" />;
  } else if (status === 'completed' && !isError) {
    badge = <Badge text="deleted" variant="success" />;
  } else if (status === 'failed' || isError) {
    badge = <Badge text="failed" variant="error" />;
  }

  return (
    <ToolCallCard
      status={status}
      description={description}
      badge={badge}
      iconUri={appIcon}
      irreversible
    >
      {status === 'pending_permission' && resourceName && (
        <KeyValueGrid rows={[{ key: 'Contact', value: resourceName, mono: true }]} />
      )}
      {isError && <ErrorBlock error={result as string} />}
      {status === 'failed' && error && <ErrorBlock error={error} />}
      {!isError && status === 'completed' && (
        <SuccessBlock message="Contact deleted successfully" />
      )}
    </ToolCallCard>
  );
}
