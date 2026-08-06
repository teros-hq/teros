/**
 * Google Contacts Renderer - Shared Components & Utilities
 */

import {
  Building2,
  ChevronRight,
  FileText,
  Mail,
  MapPin,
  Phone,
  useColors,
  User,
  Users,
} from '../../primitives';
import type React from 'react';
import { useEffect, useRef } from 'react';
import { Animated, Easing, Linking } from 'react-native';
import { Avatar, Image, Text, XStack, YStack } from 'tamagui';
import { usePulseAnimation } from '../../../../hooks/usePulseAnimation';

// ============================================================================
// Constants
// ============================================================================

const CONTACTS_ICON = 'https://ssl.gstatic.com/images/branding/product/1x/contacts_2022_48dp.png';

// ============================================================================
// Colors — Renderer UX Guide v2 §5 (theme-adaptive).
// ============================================================================
// Brand vendor (Google Contacts) hex are theme-agnostic identity colors;
// surface/text/badges come from `useColors()` and switch on theme.

export function useContactsColors() {
  const c = useColors();
  return {
    // Google Contacts brand colors (theme-agnostic)
    contactsBlue: '#1a73e8',
    contactsGreen: '#34a853',
    contactsYellow: '#fbbc04',
    contactsRed: '#ea4335',

    // Status (semantic theme-agnostic)
    success: '#22c55e',
    running: '#1a73e8',
    failed: '#ef4444',

    glowSuccess: 'rgba(34, 197, 94, 0.5)',
    glowRunning: 'rgba(26, 115, 232, 0.5)',
    glowFailed: 'rgba(239, 68, 68, 0.5)',

    // Badges (theme-adaptive)
    badgeSuccess: c.badges.ok,
    badgeError: c.badges.err,
    badgeInfo: c.badges.info,
    badgeWarning: c.badges.warn,
    badgeGray: c.badges.gray,

    // Text (theme-adaptive)
    primary: c.text,
    secondary: c.text2,
    muted: c.text3,
    bright: c.text,

    // Backgrounds (theme-adaptive)
    bgDark: c.bgInner,

    // Chevron (theme-adaptive)
    chevron: c.text3,

    // Avatar colors (theme-agnostic random pool)
    avatarColors: [
      '#ea4335', '#fbbc04', '#34a853', '#1a73e8',
      '#a142f4', '#f538a0', '#24c1e0', '#fa903e',
    ],
    ...c,
  };
}

// ============================================================================
// Types
// ============================================================================

// Contact field can be either a string or an object with value/type
export type ContactField = string | { value: string; type?: string };

// Helper to extract string value from ContactField
export function getFieldValue(field: ContactField): string {
  if (typeof field === 'string') return field;
  return field.value || '';
}

export interface Contact {
  resourceName: string;
  name?: string;
  givenName?: string;
  familyName?: string;
  emails?: ContactField[];
  phones?: ContactField[];
  organization?: string;
  title?: string;
  photo?: string;
  addresses?: ContactField[];
  notes?: string;
}

// ============================================================================
// Utilities
// ============================================================================

export function formatDuration(ms?: number): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function getShortToolName(toolName: string): string {
  const parts = toolName.split('_');
  return parts[parts.length - 1] || toolName;
}

export function parseOutput<T>(output: string): T | string | null {
  try {
    return JSON.parse(output) as T;
  } catch {
    return output;
  }
}

export function truncate(text: string, maxLength: number = 50): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}

export function getInitials(name?: string, givenName?: string, familyName?: string): string {
  if (name) {
    const parts = name.split(' ');
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }
  if (givenName && familyName) {
    return (givenName[0] + familyName[0]).toUpperCase();
  }
  if (givenName) return givenName.slice(0, 2).toUpperCase();
  if (familyName) return familyName.slice(0, 2).toUpperCase();
  return '??';
}

// Avatar palette pool (theme-agnostic — same hex across themes by design).
// Lives outside the hook so it can be consumed from pure helpers like
// `getAvatarColor` that are not hooks.
const AVATAR_COLORS = [
  '#ea4335', '#fbbc04', '#34a853', '#1a73e8',
  '#a142f4', '#f538a0', '#24c1e0', '#fa903e',
];

export function getAvatarColor(resourceName: string): string {
  // Generate consistent color based on resourceName
  let hash = 0;
  for (let i = 0; i < resourceName.length; i++) {
    hash = resourceName.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function getDisplayName(contact: Contact): string {
  if (contact.name) return contact.name;
  if (contact.givenName && contact.familyName) {
    return `${contact.givenName} ${contact.familyName}`;
  }
  if (contact.givenName) return contact.givenName;
  if (contact.familyName) return contact.familyName;
  if (contact.emails && contact.emails.length > 0) {
    return getFieldValue(contact.emails[0]);
  }
  return 'Unknown';
}

// ============================================================================
// Components
// ============================================================================

export function ContactsLogo({ size = 14 }: { size?: number }) {
  return <Image source={{ uri: CONTACTS_ICON }} width={size} height={size} borderRadius={2} />;
}

/**
 * Badge variant for in-this-file primitives. The shared `Badge` from
 * `../../primitives` is theme-adaptive and matches the canonical
 * `BadgeVariant` union ('success'|'error'|'info'|'warning'|'gray').
 * Kept locally exported so existing sub-renderers can keep their
 * imports until the next sweep.
 */
export { Badge } from '../../primitives';

interface ContactAvatarProps {
  contact: Contact;
  size?: number;
}

export function ContactAvatar({ contact, size = 32 }: ContactAvatarProps) {
  const colors = useContactsColors();
  if (contact.photo) {
    return (
      <Image source={{ uri: contact.photo }} width={size} height={size} borderRadius={size / 2} />
    );
  }

  const initials = getInitials(contact.name, contact.givenName, contact.familyName);
  const bgColor = getAvatarColor(contact.resourceName);

  return (
    <XStack
      width={size}
      height={size}
      borderRadius={size / 2}
      backgroundColor={bgColor}
      alignItems="center"
      justifyContent="center"
    >
      <Text color="white" fontSize={size * 0.4} fontWeight="600">
        {initials}
      </Text>
    </XStack>
  );
}

interface ContactRowProps {
  contact: Contact;
  onPress?: () => void;
  showDetails?: boolean;
}

export function ContactRow({ contact, onPress, showDetails = false }: ContactRowProps) {
  const c = useContactsColors();
  const colors = useContactsColors();
  const displayName = getDisplayName(contact);
  const primaryEmail = contact.emails?.[0] ? getFieldValue(contact.emails[0]) : undefined;
  const primaryPhone = contact.phones?.[0] ? getFieldValue(contact.phones[0]) : undefined;

  return (
    <XStack
      alignItems="center"
      gap={10}
      paddingVertical={8}
      paddingHorizontal={10}
      backgroundColor={c.bgInner}
      borderRadius={6}
      pressStyle={{ backgroundColor: c.border }}
      onPress={onPress}
      cursor={onPress ? 'pointer' : 'default'}
    >
      <ContactAvatar contact={contact} size={36} />

      <YStack flex={1} gap={2}>
        <Text color={c.text} fontSize={12} fontWeight="500" numberOfLines={1}>
          {displayName}
        </Text>

        {showDetails && (
          <XStack gap={12} flexWrap="wrap">
            {primaryEmail && (
              <XStack alignItems="center" gap={4}>
                <Mail size={10} color={c.text3} />
                <Text color={c.text2} fontSize={10} numberOfLines={1}>
                  {primaryEmail}
                </Text>
              </XStack>
            )}
            {primaryPhone && (
              <XStack alignItems="center" gap={4}>
                <Phone size={10} color={c.text3} />
                <Text color={c.text2} fontSize={10}>
                  {primaryPhone}
                </Text>
              </XStack>
            )}
            {contact.organization && (
              <XStack alignItems="center" gap={4}>
                <Building2 size={10} color={c.text3} />
                <Text color={c.text2} fontSize={10} numberOfLines={1}>
                  {contact.organization}
                </Text>
              </XStack>
            )}
          </XStack>
        )}

        {!showDetails && primaryEmail && (
          <Text color={c.text2} fontSize={10} numberOfLines={1}>
            {primaryEmail}
          </Text>
        )}
      </YStack>
    </XStack>
  );
}

interface ContactDetailRowProps {
  icon: React.ComponentType<any>;
  label: string;
  value: string;
  onPress?: () => void;
}

export function ContactDetailRow({ icon: Icon, label, value, onPress }: ContactDetailRowProps) {
  const c = useContactsColors();
  const colors = useContactsColors();
  return (
    <XStack
      alignItems="center"
      gap={8}
      paddingVertical={4}
      paddingHorizontal={6}
      borderRadius={4}
      pressStyle={onPress ? { backgroundColor: c.border } : undefined}
      onPress={onPress}
      cursor={onPress ? 'pointer' : 'default'}
    >
      <Icon size={12} color={colors.contactsBlue} />
      <YStack flex={1}>
        <Text color={c.text3} fontSize={9}>
          {label}
        </Text>
        <Text color={c.text} fontSize={11}>
          {value}
        </Text>
      </YStack>
    </XStack>
  );
}
