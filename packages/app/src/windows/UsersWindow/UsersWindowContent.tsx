/**
 * Users Window Content
 *
 * View and manage users:
 * - List all users with their sessions and apps
 * - View user details and statistics
 * - Manage user roles and status
 */

import {
  Calendar,
  ChevronDown,
  ChevronUp,
  Clock,
  Crown,
  DollarSign,
  Mail,
  MessageSquare,
  Package,
  Shield,
  ShieldCheck,
  User,
  Users,
} from '@tamagui/lucide-icons';
import React, { useEffect, useState } from 'react';
import { ScrollView, Separator, Text, XStack, YStack } from 'tamagui';
import { getTerosClient } from '../../../app/_layout';
import { AppSpinner, FullscreenLoader } from '../../components/ui';

interface UserData {
  userId: string;
  profile: {
    displayName: string;
    email: string;
    avatarUrl?: string;
  };
  role: 'user' | 'admin' | 'super';
  status: 'active' | 'pending_verification' | 'suspended';
  emailVerified: boolean;
  /** Whether user has full platform access (requires 3 invitations) */
  accessGranted: boolean;
  lastLoginAt?: string;
  createdAt: string;
  updatedAt: string;
  stats?: {
    apps: number;
    sessions: number;
    totalCost?: number;
  };
}

interface UsersSummary {
  total: number;
  active: number;
  admins: number;
}

const ROLE_INFO: Record<string, { label: string; color: string; icon: any }> = {
  user: { label: 'User', color: '#71717A', icon: User },
  admin: { label: 'Admin', color: '#F59E0B', icon: ShieldCheck },
  super: { label: 'Super', color: '#8B5CF6', icon: Crown },
};

const STATUS_INFO: Record<string, { label: string; color: string }> = {
  active: { label: 'Active', color: '#22C55E' },
  pending_verification: { label: 'Pending', color: '#F59E0B' },
  suspended: { label: 'Suspended', color: '#EF4444' },
};

function AccessBadge({ accessGranted }: { accessGranted: boolean }) {
  const color = accessGranted ? '#22C55E' : '#EF4444';
  const label = accessGranted ? 'Access' : 'No Access';

  return (
    <XStack
      paddingHorizontal="$2"
      paddingVertical="$1"
      backgroundColor={`${color}15`}
      borderRadius="$2"
      borderWidth={1}
      borderColor={`${color}30`}
    >
      <Text fontSize="$1" color={color} fontWeight="500">
        {label}
      </Text>
    </XStack>
  );
}

function RoleBadge({ role }: { role: string }) {
  const info = ROLE_INFO[role] || ROLE_INFO['user'];
  const Icon = info.icon;

  return (
    <XStack
      alignItems="center"
      gap="$1"
      paddingHorizontal="$2"
      paddingVertical="$1"
      backgroundColor={`${info.color}15`}
      borderRadius="$2"
      borderWidth={1}
      borderColor={`${info.color}30`}
    >
      <Icon size={12} color={info.color} />
      <Text fontSize="$1" color={info.color} fontWeight="500">
        {info.label}
      </Text>
    </XStack>
  );
}

function StatusBadge({ status }: { status: string }) {
  const info = STATUS_INFO[status] || STATUS_INFO['pending_verification'];

  return (
    <XStack
      paddingHorizontal="$2"
      paddingVertical="$1"
      backgroundColor={`${info.color}15`}
      borderRadius="$2"
    >
      <Text fontSize="$1" color={info.color}>
        {info.label}
      </Text>
    </XStack>
  );
}

function UserCard({
  user,
  expanded,
  onToggle,
}: {
  user: UserData;
  expanded: boolean;
  onToggle: () => void;
}) {
  const roleInfo = ROLE_INFO[user.role] || ROLE_INFO['user'];

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('es-ES', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const formatRelativeTime = (dateStr?: string) => {
    if (!dateStr) return 'Never';
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return formatDate(dateStr);
  };

  return (
    <YStack
      backgroundColor="rgba(20, 20, 22, 0.9)"
      borderRadius="$3"
      borderWidth={1}
      borderColor="rgba(39, 39, 42, 0.5)"
      overflow="hidden"
    >
      {/* Header */}
      <XStack
        padding="$3"
        alignItems="center"
        gap="$3"
        cursor="pointer"
        hoverStyle={{ backgroundColor: 'rgba(39, 39, 42, 0.3)' }}
        pressStyle={{ opacity: 0.8 }}
        onPress={onToggle}
      >
        {/* Avatar */}
        <YStack
          width={44}
          height={44}
          borderRadius={22}
          backgroundColor={`${roleInfo.color}15`}
          justifyContent="center"
          alignItems="center"
          overflow="hidden"
        >
          {user.profile.avatarUrl ? (
            <img
              src={user.profile.avatarUrl}
              alt={user.profile.displayName}
              style={{ width: 44, height: 44, objectFit: 'cover' }}
            />
          ) : (
            <User size={22} color={roleInfo.color} />
          )}
        </YStack>

        <YStack flex={1}>
          <XStack alignItems="center" gap="$2" flexWrap="wrap">
            <Text fontSize="$4" fontWeight="600" color="$color">
              {user.profile.displayName}
            </Text>
            <RoleBadge role={user.role} />
            <StatusBadge status={user.status} />
            <AccessBadge accessGranted={user.accessGranted} />
          </XStack>
          <XStack alignItems="center" gap="$2">
            <Mail size={12} color="#71717A" />
            <Text fontSize="$2" color="$gray11">
              {user.profile.email}
            </Text>
            {user.emailVerified && <Shield size={12} color="#22C55E" />}
          </XStack>
        </YStack>

        {/* Stats preview */}
        {user.stats && (
          <XStack gap="$3" marginRight="$2">
            <XStack alignItems="center" gap="$1">
              <Package size={14} color="#71717A" />
              <Text fontSize="$2" color="$gray11">
                {user.stats.apps}
              </Text>
            </XStack>
            <XStack alignItems="center" gap="$1">
              <MessageSquare size={14} color="#71717A" />
              <Text fontSize="$2" color="$gray11">
                {user.stats.sessions}
              </Text>
            </XStack>
            <XStack alignItems="center" gap="$1">
              <DollarSign size={14} color="#F97316" />
              <Text fontSize="$2" color="#F97316">
                {(user.stats.totalCost ?? 0).toLocaleString('en-US', {
                  style: 'currency',
                  currency: 'USD',
                })}
              </Text>
            </XStack>
          </XStack>
        )}

        {expanded ? (
          <ChevronUp size={18} color="#71717A" />
        ) : (
          <ChevronDown size={18} color="#71717A" />
        )}
      </XStack>

      {/* Expanded Content */}
      {expanded && (
        <YStack padding="$3" paddingTop={0} gap="$3">
          <Separator backgroundColor="rgba(39, 39, 42, 0.5)" />

          {/* Details */}
          <XStack gap="$6" flexWrap="wrap">
            <YStack gap="$1" minWidth={150}>
              <Text fontSize="$2" fontWeight="500" color="$gray11">
                User ID
              </Text>
              <Text fontSize="$2" color="$color" fontFamily="$mono">
                {user.userId}
              </Text>
            </YStack>

            <YStack gap="$1" minWidth={150}>
              <XStack alignItems="center" gap="$1">
                <Calendar size={12} color="#71717A" />
                <Text fontSize="$2" fontWeight="500" color="$gray11">
                  Joined
                </Text>
              </XStack>
              <Text fontSize="$2" color="$color">
                {formatDate(user.createdAt)}
              </Text>
            </YStack>

            <YStack gap="$1" minWidth={150}>
              <XStack alignItems="center" gap="$1">
                <Clock size={12} color="#71717A" />
                <Text fontSize="$2" fontWeight="500" color="$gray11">
                  Last Login
                </Text>
              </XStack>
              <Text fontSize="$2" color="$color">
                {formatRelativeTime(user.lastLoginAt)}
              </Text>
            </YStack>
          </XStack>

          {/* Stats */}
          {user.stats && (
            <XStack gap="$4" flexWrap="wrap">
              <YStack
                padding="$2"
                backgroundColor="rgba(6, 78, 97, 0.15)"
                borderRadius="$2"
                minWidth={100}
              >
                <Text fontSize="$5" fontWeight="700" color="#22D3EE">
                  {user.stats.apps}
                </Text>
                <Text fontSize="$1" color="$gray11">
                  Installed Apps
                </Text>
              </YStack>

              <YStack
                padding="$2"
                backgroundColor="rgba(34, 197, 94, 0.1)"
                borderRadius="$2"
                minWidth={100}
              >
                <Text fontSize="$5" fontWeight="700" color="#22C55E">
                  {user.stats.sessions}
                </Text>
                <Text fontSize="$1" color="$gray11">
                  Conversations
                </Text>
              </YStack>
            </XStack>
          )}
        </YStack>
      )}
    </YStack>
  );
}

export interface UsersWindowContentProps {
  windowId: string;
}

export function UsersWindowContent({ windowId }: UsersWindowContentProps) {
  const client = getTerosClient();

  const [users, setUsers] = useState<UserData[]>([]);
  const [summary, setSummary] = useState<UsersSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedUsers, setExpandedUsers] = useState<Set<string>>(new Set());

  useEffect(() => {
    const loadUsers = async () => {
      try {
        const result = await client.admin.listUsers();
        setUsers(result.users as any);
        setSummary(result.summary);
        setLoading(false);
      } catch (err: any) {
        if (err.code === 'FORBIDDEN') {
          setError('Admin privileges required');
        } else {
          setError(err.message || 'Failed to load users');
        }
        setLoading(false);
      }
    };

    if (client.isConnected()) {
      loadUsers();
    } else {
      const onConnected = () => {
        loadUsers();
        client.off('connected', onConnected);
      };
      client.on('connected', onConnected);
    }

    return () => {
      client.off('connected', () => {});
    };
  }, [client]);

  const toggleUser = (userId: string) => {
    setExpandedUsers((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  };

  if (loading) {
    return (
      <FullscreenLoader variant="default" label="Loading users..." />
    );
  }

  if (error) {
    return (
      <YStack
        flex={1}
        backgroundColor="$background"
        justifyContent="center"
        alignItems="center"
        padding="$4"
      >
        <Shield size={48} color="$red10" />
        <Text color="$red10" marginTop="$3" textAlign="center" fontWeight="600">
          {error}
        </Text>
        <Text color="$gray10" marginTop="$2" fontSize="$2" textAlign="center">
          You need admin or super privileges to view users
        </Text>
      </YStack>
    );
  }

  return (
    <YStack flex={1} backgroundColor="$background">
      <ScrollView flex={1}>
        <YStack padding="$4" gap="$4">
          {/* Summary */}
          {summary && (
            <XStack
              backgroundColor="rgba(6, 78, 97, 0.15)"
              borderRadius="$4"
              padding="$4"
              gap="$4"
              borderWidth={1}
              borderColor="rgba(6, 182, 212, 0.2)"
              flexWrap="wrap"
            >
              <YStack flex={1} minWidth={100}>
                <Text fontSize="$6" fontWeight="700" color="#22D3EE">
                  {summary.total}
                </Text>
                <Text fontSize="$2" color="$gray11">
                  Total Users
                </Text>
              </YStack>
              <YStack flex={1} minWidth={100}>
                <Text fontSize="$6" fontWeight="700" color="#22C55E">
                  {summary.active}
                </Text>
                <Text fontSize="$2" color="$gray11">
                  Active
                </Text>
              </YStack>
              <YStack flex={1} minWidth={100}>
                <Text fontSize="$6" fontWeight="700" color="#F59E0B">
                  {summary.admins}
                </Text>
                <Text fontSize="$2" color="$gray11">
                  Admins
                </Text>
              </YStack>
            </XStack>
          )}

          {/* Users List */}
          <YStack gap="$2">
            {users.map((user) => (
              <UserCard
                key={user.userId}
                user={user}
                expanded={expandedUsers.has(user.userId)}
                onToggle={() => toggleUser(user.userId)}
              />
            ))}

            {users.length === 0 && (
              <YStack padding="$6" alignItems="center">
                <Users size={48} color="$gray8" />
                <Text color="$gray10" marginTop="$3" textAlign="center">
                  No users found
                </Text>
              </YStack>
            )}
          </YStack>
        </YStack>
      </ScrollView>
    </YStack>
  );
}
