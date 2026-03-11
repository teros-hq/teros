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
  User,
  Users,
} from '@tamagui/lucide-icons';
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
// Colors
// ============================================================================

export const colors = {
  // Google Contacts brand colors
  contactsBlue: '#1a73e8',
  contactsGreen: '#34a853',
  contactsYellow: '#fbbc04',
  contactsRed: '#ea4335',

  // Status
  success: '#22c55e',
  running: '#1a73e8',
  failed: '#ef4444',

  // Status glow
  glowSuccess: 'rgba(34, 197, 94, 0.5)',
  glowRunning: 'rgba(26, 115, 232, 0.5)',
  glowFailed: 'rgba(239, 68, 68, 0.5)',

  // Badges
  badgeSuccess: { text: '#86efac', bg: 'rgba(34,197,94,0.1)' },
  badgeError: { text: '#fca5a5', bg: 'rgba(239,68,68,0.1)' },
  badgeInfo: { text: '#93c5fd', bg: 'rgba(66,133,244,0.1)' },
  badgeWarning: { text: '#fcd34d', bg: 'rgba(251,191,36,0.1)' },
  badgeGray: { text: '#a1a1aa', bg: 'rgba(255,255,255,0.06)' },

  // Text
  primary: '#d4d4d8',
  secondary: '#9ca3af',
  muted: '#52525b',
  bright: '#e4e4e7',

  // Backgrounds
  bgInner: 'rgba(0,0,0,0.2)',
  bgDark: 'rgba(0,0,0,0.3)',
  border: 'rgba(255,255,255,0.04)',

  // Chevron
  chevron: '#3f3f46',

  // Avatar colors (for contacts without photos)
  avatarColors: [
    '#ea4335', // Red
    '#fbbc04', // Yellow
    '#34a853', // Green
    '#1a73e8', // Blue
    '#a142f4', // Purple
    '#f538a0', // Pink
    '#24c1e0', // Cyan
    '#fa903e', // Orange
  ],
};

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

export function getAvatarColor(resourceName: string): string {
  // Generate consistent color based on resourceName
  let hash = 0;
  for (let i = 0; i < resourceName.length; i++) {
    hash = resourceName.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors.avatarColors[Math.abs(hash) % colors.avatarColors.length];
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

export type ToolStatusType = 'running' | 'completed' | 'failed' | 'pending_permission';

interface StatusDotProps {
  status: ToolStatusType;
}

export function StatusDot({ status }: StatusDotProps) {
  const color =
    status === 'running' || status === 'pending_permission'
      ? colors.running
      : status === 'completed'
        ? colors.success
        : colors.failed;

  const glow =
    status === 'running' || status === 'pending_permission'
      ? colors.glowRunning
      : status === 'completed'
        ? colors.glowSuccess
        : colors.glowFailed;

  const pulseAnim = usePulseAnimation(status === 'running' || status === 'pending_permission');

  return (
    <Animated.View
      style={{
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: color,
        flexShrink: 0,
        opacity: status === 'running' || status === 'pending_permission' ? pulseAnim : 1,
        shadowColor: glow,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 1,
        shadowRadius: 3,
        elevation: 3,
      }}
    />
  );
}

interface BadgeProps {
  text: string;
  variant: 'success' | 'error' | 'info' | 'warning' | 'gray';
}

export function Badge({ text, variant }: BadgeProps) {
  const styles = {
    success: colors.badgeSuccess,
    error: colors.badgeError,
    info: colors.badgeInfo,
    warning: colors.badgeWarning,
    gray: colors.badgeGray,
  };
  const { text: textColor, bg } = styles[variant];

  return (
    <XStack backgroundColor={bg} paddingHorizontal={4} paddingVertical={1} borderRadius={3}>
      <Text color={textColor} fontSize={9} fontFamily="$mono">
        {text}
      </Text>
    </XStack>
  );
}

export interface HeaderRowProps {
  status: ToolStatusType;
  description: string;
  duration?: number;
  badge?: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
  isInContainer?: boolean;
}

export function HeaderRow({
  status,
  description,
  duration,
  badge,
  expanded,
  onToggle,
  isInContainer,
}: HeaderRowProps) {
  const rotateAnim = useRef(new Animated.Value(expanded ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(rotateAnim, {
      toValue: expanded ? 1 : 0,
      duration: 150,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: true,
    }).start();
  }, [expanded, rotateAnim]);

  const rotation = rotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '90deg'],
  });

  return (
    <XStack
      alignItems="center"
      gap={8}
      paddingVertical={6}
      paddingHorizontal={10}
      backgroundColor={isInContainer ? 'transparent' : 'rgba(39,39,42,0.6)'}
      borderRadius={isInContainer ? 0 : 8}
      borderWidth={isInContainer ? 0 : 1}
      borderColor={isInContainer ? 'transparent' : colors.border}
      borderBottomWidth={isInContainer ? 1 : 1}
      borderBottomColor={colors.border}
      width={isInContainer ? undefined : '100%'}
      pressStyle={{
        backgroundColor: isInContainer ? 'rgba(255,255,255,0.02)' : 'rgba(45,45,50,0.7)',
      }}
      hoverStyle={{
        backgroundColor: isInContainer ? 'rgba(255,255,255,0.02)' : 'rgba(45,45,50,0.7)',
        borderColor: isInContainer ? 'transparent' : 'rgba(255,255,255,0.08)',
      }}
      onPress={onToggle}
      cursor="pointer"
    >
      <StatusDot status={status} />
      <ContactsLogo size={14} />

      <Text flex={1} color={colors.primary} fontSize={11} fontWeight="500" numberOfLines={1}>
        {description}
      </Text>

      {status === 'running' || status === 'pending_permission' ? (
        <Text color={colors.running} fontSize={9} fontFamily="$mono">
          {status === 'pending_permission' ? 'awaiting' : 'running'}
        </Text>
      ) : (
        duration !== undefined && (
          <Text color={colors.muted} fontSize={9} fontFamily="$mono">
            {formatDuration(duration)}
          </Text>
        )
      )}

      {badge}

      <Animated.View style={{ transform: [{ rotate: rotation }] }}>
        <ChevronRight size={10} color={colors.chevron} />
      </Animated.View>
    </XStack>
  );
}

export function ExpandedContainer({ children }: { children: React.ReactNode }) {
  return (
    <YStack
      backgroundColor="rgba(39,39,42,0.6)"
      borderRadius={8}
      borderWidth={1}
      borderColor={colors.border}
      overflow="hidden"
      width="100%"
    >
      {children}
    </YStack>
  );
}

export function ExpandedBody({ children }: { children: React.ReactNode }) {
  return (
    <YStack padding={8} gap={6}>
      {children}
    </YStack>
  );
}

export function ErrorBlock({ error }: { error: string }) {
  return (
    <YStack
      backgroundColor="rgba(239,68,68,0.1)"
      borderRadius={5}
      paddingVertical={6}
      paddingHorizontal={8}
    >
      <Text color={colors.badgeError.text} fontSize={10} fontFamily="$mono">
        {error}
      </Text>
    </YStack>
  );
}

export function SuccessBlock({ message }: { message: string }) {
  return (
    <XStack
      backgroundColor="rgba(34,197,94,0.1)"
      borderRadius={5}
      paddingVertical={6}
      paddingHorizontal={8}
      alignItems="center"
      gap={6}
    >
      <Text color={colors.badgeSuccess.text} fontSize={10}>
        {message}
      </Text>
    </XStack>
  );
}

interface ContactAvatarProps {
  contact: Contact;
  size?: number;
}

export function ContactAvatar({ contact, size = 32 }: ContactAvatarProps) {
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
  const displayName = getDisplayName(contact);
  const primaryEmail = contact.emails?.[0] ? getFieldValue(contact.emails[0]) : undefined;
  const primaryPhone = contact.phones?.[0] ? getFieldValue(contact.phones[0]) : undefined;

  return (
    <XStack
      alignItems="center"
      gap={10}
      paddingVertical={8}
      paddingHorizontal={10}
      backgroundColor={colors.bgInner}
      borderRadius={6}
      pressStyle={{ backgroundColor: 'rgba(255,255,255,0.05)' }}
      onPress={onPress}
      cursor={onPress ? 'pointer' : 'default'}
    >
      <ContactAvatar contact={contact} size={36} />

      <YStack flex={1} gap={2}>
        <Text color={colors.primary} fontSize={12} fontWeight="500" numberOfLines={1}>
          {displayName}
        </Text>

        {showDetails && (
          <XStack gap={12} flexWrap="wrap">
            {primaryEmail && (
              <XStack alignItems="center" gap={4}>
                <Mail size={10} color={colors.muted} />
                <Text color={colors.secondary} fontSize={10} numberOfLines={1}>
                  {primaryEmail}
                </Text>
              </XStack>
            )}
            {primaryPhone && (
              <XStack alignItems="center" gap={4}>
                <Phone size={10} color={colors.muted} />
                <Text color={colors.secondary} fontSize={10}>
                  {primaryPhone}
                </Text>
              </XStack>
            )}
            {contact.organization && (
              <XStack alignItems="center" gap={4}>
                <Building2 size={10} color={colors.muted} />
                <Text color={colors.secondary} fontSize={10} numberOfLines={1}>
                  {contact.organization}
                </Text>
              </XStack>
            )}
          </XStack>
        )}

        {!showDetails && primaryEmail && (
          <Text color={colors.secondary} fontSize={10} numberOfLines={1}>
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
  return (
    <XStack
      alignItems="center"
      gap={8}
      paddingVertical={4}
      paddingHorizontal={6}
      borderRadius={4}
      pressStyle={onPress ? { backgroundColor: 'rgba(255,255,255,0.05)' } : undefined}
      onPress={onPress}
      cursor={onPress ? 'pointer' : 'default'}
    >
      <Icon size={12} color={colors.contactsBlue} />
      <YStack flex={1}>
        <Text color={colors.muted} fontSize={9}>
          {label}
        </Text>
        <Text color={colors.primary} fontSize={11}>
          {value}
        </Text>
      </YStack>
    </XStack>
  );
}
