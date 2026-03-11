/**
 * MCAs Window Content
 *
 * View and manage MCA catalog:
 * - List all MCAs with their configurations
 * - View availability settings (enabled, system, hidden, role, multi)
 * - View tools, secrets, and auth configuration
 */

import {
  ChevronDown,
  ChevronUp,
  Edit3,
  Eye,
  EyeOff,
  Key,
  Lock,
  Package,
  RefreshCw,
  Save,
  Shield,
  Unlock,
  Users,
  Wrench,
  X,
} from '@tamagui/lucide-icons';
import type React from 'react';
import { useEffect, useState } from 'react';
import { Image } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, ScrollView, Separator, Sheet, Text, XStack, YStack } from 'tamagui';
import { getTerosClient } from '../../../app/_layout';
import { AppSpinner, FullscreenLoader } from '../../components/ui';

interface Mca {
  mcaId: string;
  name: string;
  description: string;
  icon?: string;
  color?: string;
  category: string;
  tools: string[];
  status: string;
  availability: {
    enabled: boolean;
    multi: boolean;
    system: boolean;
    hidden: boolean;
    role: 'user' | 'admin' | 'super';
  };
  systemSecrets: string[];
  userSecrets: string[];
  auth?: {
    type: string;
    provider?: string;
  };
}

const ROLE_COLORS: Record<string, string> = {
  user: '#22C55E',
  admin: '#F59E0B',
  super: '#EF4444',
};

function Badge({
  children,
  color,
  icon,
}: {
  children: React.ReactNode;
  color: string;
  icon?: React.ReactNode;
}) {
  return (
    <XStack
      paddingHorizontal="$2"
      paddingVertical="$1"
      backgroundColor={`${color}15`}
      borderRadius="$2"
      borderWidth={1}
      borderColor={`${color}30`}
      alignItems="center"
      gap="$1"
    >
      {icon}
      <Text fontSize="$1" color={color}>
        {children}
      </Text>
    </XStack>
  );
}

/** Check if icon is a valid HTTP URL */
function isValidIconUrl(icon?: string): boolean {
  return !!icon && (icon.startsWith('http://') || icon.startsWith('https://'));
}

/** MCA Icon component - shows HTTP image or fallback */
function McaIcon({ icon, size = 20 }: { icon?: string; size?: number }) {
  const [hasError, setHasError] = useState(false);

  if (isValidIconUrl(icon) && !hasError) {
    return (
      <Image
        source={{ uri: icon }}
        style={{ width: size, height: size }}
        onError={() => setHasError(true)}
        resizeMode="contain"
      />
    );
  }

  // Fallback: generic package icon
  return <Package size={size} color="#71717A" />;
}

interface McaCardProps {
  mca: Mca;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
}

function McaCard({ mca, expanded, onToggle, onEdit }: McaCardProps) {
  const roleColor = ROLE_COLORS[mca.availability.role] || ROLE_COLORS['user'];
  const isDisabled = !mca.availability.enabled;

  return (
    <YStack
      flexBasis="30%"
      flexGrow={1}
      minWidth={320}
      backgroundColor="rgba(20, 20, 22, 0.9)"
      borderRadius="$3"
      borderWidth={1}
      borderColor={isDisabled ? 'rgba(239, 68, 68, 0.3)' : 'rgba(39, 39, 42, 0.5)'}
      overflow="hidden"
      opacity={isDisabled ? 0.7 : 1}
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
        {/* Icon */}
        <YStack
          width={40}
          height={40}
          borderRadius={8}
          backgroundColor="rgba(39, 39, 42, 0.5)"
          justifyContent="center"
          alignItems="center"
        >
          <McaIcon icon={mca.icon} size={22} />
        </YStack>

        <YStack flex={1}>
          <XStack alignItems="center" gap="$2" flexWrap="wrap">
            <Text fontSize="$4" fontWeight="600" color="$color">
              {mca.name}
            </Text>
            {isDisabled && (
              <Badge color="#EF4444" icon={<Lock size={10} color="#EF4444" />}>
                disabled
              </Badge>
            )}
            {mca.availability.system && (
              <Badge color="#8B5CF6" icon={<Shield size={10} color="#8B5CF6" />}>
                system
              </Badge>
            )}
            {mca.availability.hidden && (
              <Badge color="#71717A" icon={<EyeOff size={10} color="#71717A" />}>
                hidden
              </Badge>
            )}
          </XStack>
          <XStack alignItems="center" gap="$2">
            <Text fontSize="$2" color="$gray11">
              {mca.category}
            </Text>
            <Text fontSize="$2" color="$gray10">
              •
            </Text>
            <Text fontSize="$2" color={roleColor}>
              {mca.availability.role}
            </Text>
            <Text fontSize="$2" color="$gray10">
              •
            </Text>
            <Text fontSize="$2" color="$gray11">
              {mca.tools.length} tools
            </Text>
            {mca.availability.multi && (
              <>
                <Text fontSize="$2" color="$gray10">
                  •
                </Text>
                <Text fontSize="$2" color="$gray11">
                  multi
                </Text>
              </>
            )}
          </XStack>
        </YStack>

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

          {/* Description */}
          <Text fontSize="$2" color="$gray11">
            {mca.description}
          </Text>

          {/* Availability Settings (Read-only with Edit button) */}
          <YStack gap="$2">
            <XStack alignItems="center" justifyContent="space-between">
              <Text fontSize="$2" fontWeight="500" color="$gray11">
                Availability
              </Text>
              <Button
                size="$2"
                backgroundColor="rgba(59, 130, 246, 0.15)"
                borderWidth={1}
                borderColor="rgba(59, 130, 246, 0.3)"
                icon={<Edit3 size={14} color="#3B82F6" />}
                onPress={onEdit}
                hoverStyle={{ backgroundColor: 'rgba(59, 130, 246, 0.25)' }}
              >
                <Text color="#3B82F6" fontSize="$2">
                  Edit
                </Text>
              </Button>
            </XStack>

            <XStack flexWrap="wrap" gap="$2">
              <XStack alignItems="center" gap="$1">
                {mca.availability.enabled ? (
                  <Unlock size={12} color="#22C55E" />
                ) : (
                  <Lock size={12} color="#EF4444" />
                )}
                <Text fontSize="$2" color={mca.availability.enabled ? '#22C55E' : '#EF4444'}>
                  {mca.availability.enabled ? 'Enabled' : 'Disabled'}
                </Text>
              </XStack>
              <Text color="$gray8">•</Text>
              <XStack alignItems="center" gap="$1">
                <Users size={12} color={roleColor} />
                <Text fontSize="$2" color={roleColor}>
                  {mca.availability.role}
                </Text>
              </XStack>
              {mca.availability.system && (
                <>
                  <Text color="$gray8">•</Text>
                  <XStack alignItems="center" gap="$1">
                    <Shield size={12} color="#8B5CF6" />
                    <Text fontSize="$2" color="#8B5CF6">
                      System
                    </Text>
                  </XStack>
                </>
              )}
              {mca.availability.hidden && (
                <>
                  <Text color="$gray8">•</Text>
                  <XStack alignItems="center" gap="$1">
                    <EyeOff size={12} color="#71717A" />
                    <Text fontSize="$2" color="#71717A">
                      Hidden
                    </Text>
                  </XStack>
                </>
              )}
              {mca.availability.multi && (
                <>
                  <Text color="$gray8">•</Text>
                  <XStack alignItems="center" gap="$1">
                    <Users size={12} color="#06B6D4" />
                    <Text fontSize="$2" color="#06B6D4">
                      Multi
                    </Text>
                  </XStack>
                </>
              )}
            </XStack>
          </YStack>

          {/* Tools */}
          <YStack gap="$2">
            <XStack alignItems="center" gap="$2">
              <Wrench size={14} color="#71717A" />
              <Text fontSize="$2" fontWeight="500" color="$gray11">
                Tools ({mca.tools.length})
              </Text>
            </XStack>
            <XStack flexWrap="wrap" gap="$1">
              {mca.tools.map((tool, i) => (
                <Text
                  key={i}
                  fontSize="$1"
                  color="$gray11"
                  backgroundColor="rgba(39, 39, 42, 0.5)"
                  paddingHorizontal="$2"
                  paddingVertical="$1"
                  borderRadius="$1"
                  fontFamily="$mono"
                >
                  {tool}
                </Text>
              ))}
            </XStack>
          </YStack>

          {/* Secrets */}
          {(mca.systemSecrets.length > 0 || mca.userSecrets.length > 0) && (
            <YStack gap="$2">
              <XStack alignItems="center" gap="$2">
                <Key size={14} color="#71717A" />
                <Text fontSize="$2" fontWeight="500" color="$gray11">
                  Secrets
                </Text>
              </XStack>
              {mca.systemSecrets.length > 0 && (
                <YStack gap="$1">
                  <Text fontSize="$1" color="$gray10">
                    System secrets:
                  </Text>
                  <XStack flexWrap="wrap" gap="$1">
                    {mca.systemSecrets.map((secret, i) => (
                      <Text
                        key={i}
                        fontSize="$1"
                        color="$gray11"
                        backgroundColor="rgba(39, 39, 42, 0.5)"
                        paddingHorizontal="$2"
                        paddingVertical="$1"
                        borderRadius="$1"
                        fontFamily="$mono"
                      >
                        {secret}
                      </Text>
                    ))}
                  </XStack>
                </YStack>
              )}
              {mca.userSecrets.length > 0 && (
                <YStack gap="$1">
                  <Text fontSize="$1" color="$gray10">
                    User secrets:
                  </Text>
                  <XStack flexWrap="wrap" gap="$1">
                    {mca.userSecrets.map((secret, i) => (
                      <Text
                        key={i}
                        fontSize="$1"
                        color="$gray11"
                        backgroundColor="rgba(39, 39, 42, 0.5)"
                        paddingHorizontal="$2"
                        paddingVertical="$1"
                        borderRadius="$1"
                        fontFamily="$mono"
                      >
                        {secret}
                      </Text>
                    ))}
                  </XStack>
                </YStack>
              )}
            </YStack>
          )}

          {/* Auth */}
          {mca.auth && (
            <YStack gap="$2">
              <XStack alignItems="center" gap="$2">
                <Shield size={14} color="#71717A" />
                <Text fontSize="$2" fontWeight="500" color="$gray11">
                  Authentication
                </Text>
              </XStack>
              <XStack gap="$2">
                <Text fontSize="$2" color="$gray11">
                  type: {mca.auth.type}
                  {mca.auth.provider && ` • provider: ${mca.auth.provider}`}
                </Text>
              </XStack>
            </YStack>
          )}

          {/* MCP ID */}
          <Text fontSize="$1" color="$gray10" fontFamily="$mono">
            {mca.mcaId}
          </Text>
        </YStack>
      )}
    </YStack>
  );
}

export interface McasWindowContentProps {
  windowId: string;
}

export function McasWindowContent({ windowId }: McasWindowContentProps) {
  const client = getTerosClient();
  const insets = useSafeAreaInsets();

  const [mcas, setMcas] = useState<Mca[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedMcas, setExpandedMcas] = useState<Set<string>>(new Set());
  const [filterCategory, setFilterCategory] = useState<string | null>(null);
  const [showDisabled, setShowDisabled] = useState(true);
  const [showSystem, setShowSystem] = useState(true);
  const [showHidden, setShowHidden] = useState(true);
  const [editingMca, setEditingMca] = useState<Mca | null>(null);
  const [editForm, setEditForm] = useState({
    enabled: true,
    system: false,
    hidden: false,
    role: 'user' as 'user' | 'admin' | 'super',
  });
  const [saving, setSaving] = useState(false);

  const toggleMca = (mcaId: string) => {
    setExpandedMcas((prev) => {
      const next = new Set(prev);
      if (next.has(mcaId)) {
        next.delete(mcaId);
      } else {
        next.add(mcaId);
      }
      return next;
    });
  };

  const loadMcas = async () => {
    setLoading(true);
    try {
      const mcasList = (await client.app.listAllMcas()).mcas as Mca[];
      setMcas(mcasList as Mca[]);
    } catch (err) {
      console.error('Failed to load MCAs:', err);
      setError(err instanceof Error ? err.message : 'Failed to load MCAs');
    } finally {
      setLoading(false);
    }
  };

  const openEditSheet = (mca: Mca) => {
    setEditForm({
      enabled: mca.availability.enabled,
      system: mca.availability.system,
      hidden: mca.availability.hidden,
      role: mca.availability.role,
    });
    setEditingMca(mca);
  };

  const closeEditSheet = () => {
    setEditingMca(null);
  };

  const saveAvailability = async () => {
    if (!editingMca) return;

    console.log('💾 Saving MCA availability:', editingMca.mcaId, editForm);
    setSaving(true);
    try {
      const updatedMca = (await client.app.updateMca(editingMca.mcaId, editForm)).mca as Mca;
      console.log('✅ MCA updated successfully:', updatedMca);
      // Update local state with the updated MCA
      setMcas((prev) =>
        prev.map((mca) => (mca.mcaId === editingMca.mcaId ? { ...mca, ...updatedMca } : mca)),
      );
      setEditingMca(null);
    } catch (err) {
      console.error('❌ Failed to update MCA:', err);
      alert(`Failed to update MCA: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (client.isConnected()) {
      loadMcas();
    } else {
      const onConnected = () => {
        loadMcas();
        client.off('connected', onConnected);
      };
      client.on('connected', onConnected);

      return () => {
        client.off('connected', onConnected);
      };
    }
  }, [client]);

  if (loading) {
    return (
      <FullscreenLoader variant="default" label="Loading MCAs..." />
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
        <Text color="$red10" textAlign="center">
          {error}
        </Text>
      </YStack>
    );
  }

  // Get categories
  const categories = [...new Set(mcas.map((m) => m.category))].sort();

  // Filter MCAs
  let filteredMcas = mcas;
  if (filterCategory) {
    filteredMcas = filteredMcas.filter((m) => m.category === filterCategory);
  }
  if (!showDisabled) {
    filteredMcas = filteredMcas.filter((m) => m.availability.enabled);
  }
  if (!showSystem) {
    filteredMcas = filteredMcas.filter((m) => !m.availability.system);
  }
  if (!showHidden) {
    filteredMcas = filteredMcas.filter((m) => !m.availability.hidden);
  }

  // Sort MCAs by name
  const sortedMcas = [...filteredMcas].sort((a, b) => a.name.localeCompare(b.name));

  // Stats
  const enabledCount = mcas.filter((m) => m.availability.enabled).length;
  const systemCount = mcas.filter((m) => m.availability.system).length;
  const hiddenCount = mcas.filter((m) => m.availability.hidden).length;
  const totalTools = mcas.reduce((acc, m) => acc + m.tools.length, 0);

  return (
    <YStack flex={1} backgroundColor="$background">
      <ScrollView flex={1}>
        <YStack padding="$4" gap="$4">
          {/* Summary */}
          <XStack
            backgroundColor="rgba(39, 39, 42, 0.3)"
            borderRadius="$4"
            padding="$4"
            gap="$4"
            borderWidth={1}
            borderColor="rgba(63, 63, 70, 0.3)"
            flexWrap="wrap"
            justifyContent="space-between"
            alignItems="center"
          >
            <XStack gap="$4" flexWrap="wrap">
              <YStack minWidth={80}>
                <Text fontSize="$6" fontWeight="700" color="$color">
                  {mcas.length}
                </Text>
                <Text fontSize="$2" color="$gray11">
                  Total
                </Text>
              </YStack>
              <YStack minWidth={80}>
                <Text fontSize="$6" fontWeight="700" color="$color">
                  {enabledCount}
                </Text>
                <Text fontSize="$2" color="$gray11">
                  Enabled
                </Text>
              </YStack>
              <YStack minWidth={80}>
                <Text fontSize="$6" fontWeight="700" color="$color">
                  {systemCount}
                </Text>
                <Text fontSize="$2" color="$gray11">
                  System
                </Text>
              </YStack>
              <YStack minWidth={80}>
                <Text fontSize="$6" fontWeight="700" color="$color">
                  {totalTools}
                </Text>
                <Text fontSize="$2" color="$gray11">
                  Tools
                </Text>
              </YStack>
            </XStack>

            <Button
              size="$3"
              icon={<RefreshCw size={16} />}
              backgroundColor="rgba(39, 39, 42, 0.5)"
              borderColor="rgba(63, 63, 70, 0.5)"
              color="$gray11"
              onPress={loadMcas}
            >
              Refresh
            </Button>
          </XStack>

          {/* Filters */}
          <YStack gap="$2">
            {/* Category Filter */}
            <XStack gap="$2" flexWrap="wrap">
              <Button
                size="$2"
                backgroundColor={
                  filterCategory === null ? 'rgba(63, 63, 70, 0.5)' : 'rgba(39, 39, 42, 0.3)'
                }
                borderColor="rgba(63, 63, 70, 0.5)"
                color="$gray11"
                onPress={() => setFilterCategory(null)}
              >
                All ({mcas.length})
              </Button>
              {categories.map((category) => {
                const count = mcas.filter((m) => m.category === category).length;
                return (
                  <Button
                    key={category}
                    size="$2"
                    backgroundColor={
                      filterCategory === category
                        ? 'rgba(63, 63, 70, 0.5)'
                        : 'rgba(39, 39, 42, 0.3)'
                    }
                    borderColor="rgba(63, 63, 70, 0.5)"
                    color="$gray11"
                    onPress={() => setFilterCategory(category)}
                  >
                    {category} ({count})
                  </Button>
                );
              })}
            </XStack>

            {/* Toggle Filters */}
            <XStack gap="$2" flexWrap="wrap">
              <Button
                size="$2"
                icon={showDisabled ? <Eye size={14} /> : <EyeOff size={14} />}
                backgroundColor={showDisabled ? 'rgba(39, 39, 42, 0.5)' : 'rgba(39, 39, 42, 0.3)'}
                borderColor="rgba(63, 63, 70, 0.5)"
                color="$gray11"
                onPress={() => setShowDisabled(!showDisabled)}
              >
                Disabled ({mcas.filter((m) => !m.availability.enabled).length})
              </Button>
              <Button
                size="$2"
                icon={<Shield size={14} />}
                backgroundColor={showSystem ? 'rgba(39, 39, 42, 0.5)' : 'rgba(39, 39, 42, 0.3)'}
                borderColor="rgba(63, 63, 70, 0.5)"
                color="$gray11"
                onPress={() => setShowSystem(!showSystem)}
              >
                System ({systemCount})
              </Button>
              <Button
                size="$2"
                icon={<EyeOff size={14} />}
                backgroundColor={showHidden ? 'rgba(39, 39, 42, 0.5)' : 'rgba(39, 39, 42, 0.3)'}
                borderColor="rgba(63, 63, 70, 0.5)"
                color="$gray11"
                onPress={() => setShowHidden(!showHidden)}
              >
                Hidden ({hiddenCount})
              </Button>
            </XStack>
          </YStack>

          {/* MCAs List - Grouped by availability */}
          <YStack gap="$4">
            {(() => {
              // Group MCAs by availability type
              const groups = {
                system: sortedMcas.filter(
                  (m) => m.availability.system && m.availability.enabled && !m.availability.hidden,
                ),
                admin: sortedMcas.filter(
                  (m) =>
                    !m.availability.system &&
                    m.availability.enabled &&
                    !m.availability.hidden &&
                    (m.availability.role === 'admin' || m.availability.role === 'super'),
                ),
                user: sortedMcas.filter(
                  (m) =>
                    !m.availability.system &&
                    m.availability.enabled &&
                    !m.availability.hidden &&
                    m.availability.role === 'user',
                ),
                hidden: sortedMcas.filter((m) => m.availability.enabled && m.availability.hidden),
                disabled: sortedMcas.filter((m) => !m.availability.enabled),
              };

              const groupConfig = [
                {
                  key: 'system',
                  label: 'System',
                  icon: <Shield size={14} color="#8B5CF6" />,
                  color: '#8B5CF6',
                  mcas: groups.system,
                },
                {
                  key: 'admin',
                  label: 'Admin Only',
                  icon: <Users size={14} color="#F59E0B" />,
                  color: '#F59E0B',
                  mcas: groups.admin,
                },
                {
                  key: 'user',
                  label: 'User',
                  icon: <Users size={14} color="#22C55E" />,
                  color: '#22C55E',
                  mcas: groups.user,
                },
                {
                  key: 'hidden',
                  label: 'Hidden',
                  icon: <EyeOff size={14} color="#71717A" />,
                  color: '#71717A',
                  mcas: groups.hidden,
                },
                {
                  key: 'disabled',
                  label: 'Disabled',
                  icon: <Lock size={14} color="#EF4444" />,
                  color: '#EF4444',
                  mcas: groups.disabled,
                },
              ];

              const nonEmptyGroups = groupConfig.filter((g) => g.mcas.length > 0);

              if (nonEmptyGroups.length === 0) {
                return (
                  <YStack padding="$6" alignItems="center">
                    <Package size={48} color="$gray8" />
                    <Text color="$gray10" marginTop="$3" textAlign="center">
                      No MCAs match the current filters
                    </Text>
                  </YStack>
                );
              }

              return nonEmptyGroups.map((group) => (
                <YStack key={group.key} gap="$2">
                  {/* Group Header */}
                  <XStack alignItems="center" gap="$2" paddingVertical="$1">
                    {group.icon}
                    <Text fontSize="$3" fontWeight="600" color={group.color}>
                      {group.label}
                    </Text>
                    <Text fontSize="$2" color="$gray10">
                      ({group.mcas.length})
                    </Text>
                  </XStack>

                  {/* Group MCAs */}
                  <XStack gap="$2" flexWrap="wrap">
                    {group.mcas.map((mca) => (
                      <McaCard
                        key={mca.mcaId}
                        mca={mca}
                        expanded={expandedMcas.has(mca.mcaId)}
                        onToggle={() => toggleMca(mca.mcaId)}
                        onEdit={() => openEditSheet(mca)}
                      />
                    ))}
                  </XStack>
                </YStack>
              ));
            })()}
          </YStack>
        </YStack>
      </ScrollView>

      {/* Edit Availability Sheet */}
      <Sheet
        modal
        open={!!editingMca}
        onOpenChange={(open) => !open && closeEditSheet()}
        snapPoints={[70]}
        dismissOnSnapToBottom
        zIndex={100000}
      >
        <Sheet.Overlay
          animation="lazy"
          enterStyle={{ opacity: 0 }}
          exitStyle={{ opacity: 0 }}
          backgroundColor="rgba(0, 0, 0, 0.5)"
        />
        <Sheet.Frame
          backgroundColor="#18181B"
          borderTopLeftRadius="$5"
          borderTopRightRadius="$5"
          padding="$4"
          paddingBottom={Math.max(insets.bottom, 40)}
          gap="$4"
        >
          <Sheet.Handle backgroundColor="rgba(113, 113, 122, 0.5)" />

          {editingMca && (
            <YStack gap="$4">
              {/* Header */}
              <XStack justifyContent="space-between" alignItems="center">
                <YStack>
                  <Text fontSize="$5" fontWeight="600" color="$color">
                    Edit Availability
                  </Text>
                  <Text fontSize="$2" color="$gray11">
                    {editingMca.name}
                  </Text>
                </YStack>
                <Button
                  size="$2"
                  circular
                  backgroundColor="transparent"
                  icon={<X size={18} color="$gray11" />}
                  onPress={closeEditSheet}
                />
              </XStack>

              {/* Toggle Controls */}
              <YStack gap="$3">
                {/* Enabled */}
                <XStack alignItems="center" justifyContent="space-between" paddingVertical="$2">
                  <XStack alignItems="center" gap="$2">
                    {editForm.enabled ? (
                      <Unlock size={16} color="#22C55E" />
                    ) : (
                      <Lock size={16} color="#EF4444" />
                    )}
                    <YStack>
                      <Text fontSize="$3" color="$color">
                        Enabled
                      </Text>
                      <Text fontSize="$1" color="$gray10">
                        Allow this MCA to be installed
                      </Text>
                    </YStack>
                  </XStack>
                  <Button
                    size="$3"
                    backgroundColor={editForm.enabled ? '#22C55E' : 'rgba(63, 63, 70, 0.5)'}
                    borderRadius="$4"
                    paddingHorizontal="$4"
                    onPress={() => setEditForm((prev) => ({ ...prev, enabled: !prev.enabled }))}
                  >
                    <Text fontSize="$2" color="white" fontWeight="600">
                      {editForm.enabled ? 'ON' : 'OFF'}
                    </Text>
                  </Button>
                </XStack>

                {/* System */}
                <XStack alignItems="center" justifyContent="space-between" paddingVertical="$2">
                  <XStack alignItems="center" gap="$2">
                    <Shield size={16} color={editForm.system ? '#8B5CF6' : '#71717A'} />
                    <YStack>
                      <Text fontSize="$3" color="$color">
                        System MCA
                      </Text>
                      <Text fontSize="$1" color="$gray10">
                        Auto-install for all agents
                      </Text>
                    </YStack>
                  </XStack>
                  <Button
                    size="$3"
                    backgroundColor={editForm.system ? '#8B5CF6' : 'rgba(63, 63, 70, 0.5)'}
                    borderRadius="$4"
                    paddingHorizontal="$4"
                    onPress={() => setEditForm((prev) => ({ ...prev, system: !prev.system }))}
                  >
                    <Text fontSize="$2" color="white" fontWeight="600">
                      {editForm.system ? 'ON' : 'OFF'}
                    </Text>
                  </Button>
                </XStack>

                {/* Hidden */}
                <XStack alignItems="center" justifyContent="space-between" paddingVertical="$2">
                  <XStack alignItems="center" gap="$2">
                    {editForm.hidden ? (
                      <EyeOff size={16} color="#71717A" />
                    ) : (
                      <Eye size={16} color="#22C55E" />
                    )}
                    <YStack>
                      <Text fontSize="$3" color="$color">
                        Hidden
                      </Text>
                      <Text fontSize="$1" color="$gray10">
                        Hide from catalog listing
                      </Text>
                    </YStack>
                  </XStack>
                  <Button
                    size="$3"
                    backgroundColor={editForm.hidden ? '#71717A' : 'rgba(63, 63, 70, 0.5)'}
                    borderRadius="$4"
                    paddingHorizontal="$4"
                    onPress={() => setEditForm((prev) => ({ ...prev, hidden: !prev.hidden }))}
                  >
                    <Text fontSize="$2" color="white" fontWeight="600">
                      {editForm.hidden ? 'ON' : 'OFF'}
                    </Text>
                  </Button>
                </XStack>

                {/* Role Selector */}
                <YStack gap="$2" paddingVertical="$2">
                  <XStack alignItems="center" gap="$2">
                    <Users size={16} color={ROLE_COLORS[editForm.role]} />
                    <YStack>
                      <Text fontSize="$3" color="$color">
                        Required Role
                      </Text>
                      <Text fontSize="$1" color="$gray10">
                        Minimum role to install this MCA
                      </Text>
                    </YStack>
                  </XStack>
                  <XStack gap="$2" marginTop="$2">
                    {(['user', 'admin', 'super'] as const).map((role) => (
                      <Button
                        key={role}
                        flex={1}
                        size="$3"
                        backgroundColor={
                          editForm.role === role ? ROLE_COLORS[role] : 'rgba(63, 63, 70, 0.5)'
                        }
                        borderRadius="$3"
                        onPress={() => setEditForm((prev) => ({ ...prev, role }))}
                      >
                        <Text fontSize="$2" color="white" fontWeight="500">
                          {role}
                        </Text>
                      </Button>
                    ))}
                  </XStack>
                </YStack>
              </YStack>

              {/* Action Buttons */}
              <XStack gap="$3" marginTop="$2">
                <Button
                  flex={1}
                  size="$4"
                  onPress={closeEditSheet}
                  disabled={saving}
                  backgroundColor="rgba(39, 39, 42, 0.5)"
                  borderWidth={1}
                  borderColor="rgba(63, 63, 70, 0.5)"
                >
                  <Text color="$gray11">Cancel</Text>
                </Button>
                <Button
                  flex={1}
                  size="$4"
                  onPress={saveAvailability}
                  disabled={saving}
                  backgroundColor="rgba(34, 197, 94, 0.2)"
                  borderWidth={1}
                  borderColor="rgba(34, 197, 94, 0.4)"
                  icon={saving ? <AppSpinner size="sm" /> : <Save size={16} color="#22C55E" />}
                >
                  <Text color="#22C55E">{saving ? 'Saving...' : 'Save'}</Text>
                </Button>
              </XStack>
            </YStack>
          )}
        </Sheet.Frame>
      </Sheet>
    </YStack>
  );
}
