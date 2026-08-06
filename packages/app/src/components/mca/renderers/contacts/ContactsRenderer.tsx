/**
 * Google Contacts Renderer - Contact Operations
 *
 * Renderers for list, get, search, create, update, delete contacts.
 */

import {
  Building2,
  ExternalLink,
  FileText,
  Mail,
  MapPin,
  Phone,
  Search,
  User,
  UserCog,
  UserMinus,
  UserPlus,
  Users,
} from '../../primitives';
import type React from 'react';
import { useState } from 'react';
import { Linking } from 'react-native';
import { ScrollView, Text, XStack, YStack } from 'tamagui';

import { countBadgeVariant, formatCountBadge } from '../../primitives';
import type { ToolCallRendererProps } from '../../types';
import { ErrorBlock, SuccessBlock, ToolCallCard } from '../../primitives';
import {
  Badge,
  type Contact,
  ContactAvatar,
  ContactDetailRow,
  ContactRow,
  getDisplayName,
  getFieldValue,
  getShortToolName,
  parseOutput,
  useContactsColors,
} from './shared';

// ============================================================================
// List Contacts Renderer
// ============================================================================

interface ListContactsResult {
  contacts: Contact[];
  totalItems?: number;
  nextPageToken?: string;
}

export function ListContactsRenderer({
  toolName,
  status,
  output,
  appIcon,
}: ToolCallRendererProps) {
  const c = useContactsColors();
  const colors = useContactsColors();

  const result = output ? parseOutput<ListContactsResult>(output) : null;
  const isError = typeof result === 'string' && result.toLowerCase().includes('error');

  let badge: React.ReactNode = null;
  let description = 'List contacts';

  if (status === 'completed' && result && typeof result === 'object') {
    const count = result.contacts?.length || 0;
    const total = result.totalItems;
    const text = total ? `${count}/${total}` : formatCountBadge(count, 'contact');
    badge = <Badge text={text} variant={countBadgeVariant(count)} />;
    description = `Listed ${count} contacts`;
  } else if (status === 'failed' || isError) {
    badge = <Badge text="failed" variant="error" />;
  }

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
      {isError && <ErrorBlock error={result as string} />}
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

export function GetContactRenderer({ toolName, status, output, appIcon }: ToolCallRendererProps) {
  const c = useContactsColors();
  const colors = useContactsColors();

  const result = output ? parseOutput<Contact>(output) : null;
  const isError = typeof result === 'string' && result.toLowerCase().includes('error');

  let badge: React.ReactNode = null;
  let description = 'Get contact';

  if (status === 'completed' && result && typeof result === 'object') {
    const name = getDisplayName(result as Contact);
    badge = <Badge text="found" variant="success" />;
    description = name;
  } else if (status === 'failed' || isError) {
    badge = <Badge text="failed" variant="error" />;
  }

  const contact = result as Contact;

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
      {isError && <ErrorBlock error={result as string} />}
      {contact && typeof contact === 'object' && (
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

interface SearchContactsResult {
  contacts: Contact[];
  totalItems?: number;
}

export function SearchContactsRenderer({
  toolName,
  status,
  output,
  input,
  appIcon,
}: ToolCallRendererProps) {
  const c = useContactsColors();
  const colors = useContactsColors();

  const result = output ? parseOutput<SearchContactsResult>(output) : null;
  const isError = typeof result === 'string' && result.toLowerCase().includes('error');
  const query = typeof input?.query === 'string' ? input.query : '';

  let badge: React.ReactNode = null;
  const description = query ? `Search: "${query}"` : 'Search contacts';

  if (status === 'completed' && result && typeof result === 'object') {
    const count = result.contacts?.length || 0;
    badge = <Badge text={formatCountBadge(count, 'result')} variant={countBadgeVariant(count)} />;
  } else if (status === 'failed' || isError) {
    badge = <Badge text="failed" variant="error" />;
  }

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
      {isError && <ErrorBlock error={result as string} />}
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
  toolName,
  status,
  output,
  appIcon,
}: ToolCallRendererProps) {
  const result = output ? parseOutput<Contact>(output) : null;
  const isError = typeof result === 'string' && result.toLowerCase().includes('error');

  let badge: React.ReactNode = null;
  let description = 'Create contact';

  if (status === 'completed' && result && typeof result === 'object') {
    const name = getDisplayName(result as Contact);
    badge = <Badge text="created" variant="success" />;
    description = `Created: ${name}`;
  } else if (status === 'failed' || isError) {
    badge = <Badge text="failed" variant="error" />;
  }

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
      {isError && <ErrorBlock error={result as string} />}
      {result && typeof result === 'object' && (
        <SuccessBlock
          message={`Contact "${getDisplayName(result as Contact)}" created successfully`}
        />
      )}
    </ToolCallCard>
  );
}

// ============================================================================
// Update Contact Renderer
// ============================================================================

export function UpdateContactRenderer({
  toolName,
  status,
  output,
  appIcon,
}: ToolCallRendererProps) {
  const result = output ? parseOutput<Contact>(output) : null;
  const isError = typeof result === 'string' && result.toLowerCase().includes('error');

  let badge: React.ReactNode = null;
  let description = 'Update contact';

  if (status === 'completed' && result && typeof result === 'object') {
    const name = getDisplayName(result as Contact);
    badge = <Badge text="updated" variant="success" />;
    description = `Updated: ${name}`;
  } else if (status === 'failed' || isError) {
    badge = <Badge text="failed" variant="error" />;
  }

  return (
    <ToolCallCard status={status} description={description} badge={badge} iconUri={appIcon}>
      {isError && <ErrorBlock error={result as string} />}
      {result && typeof result === 'object' && (
        <SuccessBlock
          message={`Contact "${getDisplayName(result as Contact)}" updated successfully`}
        />
      )}
    </ToolCallCard>
  );
}

// ============================================================================
// Delete Contact Renderer
// ============================================================================

interface DeleteResult {
  success?: boolean;
  message?: string;
}

export function DeleteContactRenderer({
  toolName,
  status,
  output,
  appIcon,
}: ToolCallRendererProps) {
  const result = output ? parseOutput<DeleteResult>(output) : null;
  const isError = typeof result === 'string' && result.toLowerCase().includes('error');

  let badge: React.ReactNode = null;
  let description = 'Delete contact';

  if (status === 'completed' && !isError) {
    badge = <Badge text="deleted" variant="success" />;
    description = 'Contact deleted';
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
      {isError && <ErrorBlock error={result as string} />}
      {!isError && status === 'completed' && (
        <SuccessBlock message="Contact deleted successfully" />
      )}
    </ToolCallCard>
  );
}
