/**
 * Feature Flags Window Content
 *
 * Admin panel for managing feature flags:
 * - List all registered flags with search/filter
 * - View/edit flag detail (default value, overrides)
 * - Add/edit/delete overrides
 * - Real-time updates with row highlighting
 *
 * Only accessible to users with role "super".
 */

import {
  ArrowLeft,
  Check,
  ChevronRight,
  Flag,
  Pencil,
  Plus,
  RefreshCcw,
  Save,
  Search,
  Shield,
  Trash2,
  X,
} from '@tamagui/lucide-icons';
import * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ScrollView,
  Switch,
  TextInput,
  TouchableOpacity,
} from 'react-native';
import { Button, Sheet, Text, XStack, YStack } from 'tamagui';
import { AppSpinner, FullscreenLoader } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { getTerosClient } from '../../services/terosClientSingleton';
import type {
  FeatureFlagItem,
  FeatureFlagOverrideItem,
} from '../../services/FeatureFlagApi';
import type { FeatureFlagsWindowProps } from './definition';
import { useColors } from '../../components/mca/primitives/useColors';
import { colors as semanticColors, surface, indicators, controlsBar } from '../../components/mca/primitives/colors';

// ============================================================================
// Types
// ============================================================================

interface Props extends FeatureFlagsWindowProps {
  windowId: string;
}

type Screen = 'list' | 'detail';

interface FlagWithHighlight extends FeatureFlagItem {
  highlight?: boolean;
}

interface ConfirmModalState {
  open: boolean;
  flagKey: string;
  newValue: unknown;
  oldValue: unknown;
  type: string;
  onConfirm: () => void;
}

// ============================================================================
// Helpers
// ============================================================================

function formatValue(value: unknown, type: string): string {
  if (value === undefined || value === null) return '—';
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'string[]') return (value as string[]).join(', ');
  return String(value);
}

function getTypeColor(type: string): string {
  switch (type) {
    case 'boolean':
      return semanticColors.green;
    case 'number':
      return semanticColors.indigo;
    case 'string':
      return semanticColors.violet;
    case 'string[]':
      return semanticColors.amber;
    default:
      return semanticColors.indigo;
  }
}

function getDefaultForType(type: string): unknown {
  switch (type) {
    case 'boolean':
      return false;
    case 'number':
      return 0;
    case 'string':
      return '';
    case 'string[]':
      return [];
    default:
      return null;
  }
}

// ============================================================================
// Component
// ============================================================================

export function FeatureFlagsWindowContent({ windowId, search: initialSearch }: Props) {
  const { t } = useTranslation();
  const c = useColors();
  const isDark = c.bgPage === surface.dark.bgPage;
  const client = getTerosClient();
  const toast = useToast();

  // -- Navigation state --
  const [screen, setScreen] = useState<Screen>('list');
  const [selectedFlagKey, setSelectedFlagKey] = useState<string | null>(null);

  // -- List state --
  const [flags, setFlags] = useState<FlagWithHighlight[]>([]);
  const [searchQuery, setSearchQuery] = useState(initialSearch || '');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // -- Detail state --
  const [detailFlag, setDetailFlag] = useState<FeatureFlagItem | null>(null);
  const [overrides, setOverrides] = useState<FeatureFlagOverrideItem[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [defaultValueDraft, setDefaultValueDraft] = useState<unknown>(undefined);
  const [hasDefaultChanged, setHasDefaultChanged] = useState(false);
  const [savingDefault, setSavingDefault] = useState(false);
  const [resettingDefault, setResettingDefault] = useState(false);

  // -- Override edit state --
  const [editingOverride, setEditingOverride] = useState<FeatureFlagOverrideItem | null>(null);
  const [editDraftValue, setEditDraftValue] = useState<unknown>(undefined);
  const [editDraftNote, setEditDraftNote] = useState('');
  const [savingOverride, setSavingOverride] = useState(false);
  const [deletingOverride, setDeletingOverride] = useState<string | null>(null);

  // -- Add override modal state --
  const [showAddModal, setShowAddModal] = useState(false);
  const [addTargetType, setAddTargetType] = useState<'workspace' | 'user' | 'company'>('workspace');
  const [addTargetId, setAddTargetId] = useState('');
  const [addValue, setAddValue] = useState<unknown>(undefined);
  const [addNote, setAddNote] = useState('');
  const [addSaving, setAddSaving] = useState(false);

  // -- Confirmation modal state --
  const [confirmModal, setConfirmModal] = useState<ConfirmModalState>({
    open: false,
    flagKey: '',
    newValue: undefined,
    oldValue: undefined,
    type: 'boolean',
    onConfirm: () => {},
  });

  // -- Connection state --
  const [connected, setConnected] = useState(client.isConnected());

  // -- Highlight refs --
  const highlightTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // ==========================================================================
  // Load initial data
  // ==========================================================================

  const loadFlags = useCallback(async () => {
    try {
      const result = await client.featureFlags.list();
      setFlags((prev) => {
        // Preserve highlights from previous state
        const prevMap = new Map(prev.map((f) => [f.key, f]));
        return result.flags.map((f) => ({
          ...f,
          highlight: prevMap.get(f.key)?.highlight ?? false,
        }));
      });
      setError(null);
    } catch (err: any) {
      setError(err.code === 'FORBIDDEN' ? t('featureFlags.adminPrivilegesRequired') : err.message || t('featureFlags.failedToLoadFlags'));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    const tryLoad = async () => {
      if (client.isConnected()) {
        loadFlags();
      } else {
        const onConnected = () => {
          client.off('connected', onConnected);
          loadFlags();
        };
        client.on('connected', onConnected);
      }
    };
    tryLoad();

    // Connection monitoring
    const onConnected = () => setConnected(true);
    const onDisconnected = () => setConnected(false);
    client.on('connected', onConnected);
    client.on('disconnected', onDisconnected);

    return () => {
      client.off('connected', onConnected);
      client.off('disconnected', onDisconnected);
    };
  }, [client, loadFlags]);

  // ==========================================================================
  // Real-time updates
  // ==========================================================================

  useEffect(() => {
    const handleFlagChange = (data: any) => {
      if (!data?.changes) return;

      const changedKeys = new Set(data.changes.map((c: any) => c.flagKey));

      // Refresh flags list
      loadFlags();

      // Highlight changed rows
      setFlags((prev) =>
        prev.map((f) => {
          if (changedKeys.has(f.key)) {
            // Clear existing timer for this key
            const existing = highlightTimers.current.get(f.key);
            if (existing) clearTimeout(existing);

            // Set new timer
            const timer = setTimeout(() => {
              setFlags((p) => p.map((ff) => (ff.key === f.key ? { ...ff, highlight: false } : ff)));
              highlightTimers.current.delete(f.key);
            }, 3000);
            highlightTimers.current.set(f.key, timer);

            return { ...f, highlight: true };
          }
          return f;
        }),
      );

      // If viewing detail of changed flag, refresh overrides
      if (selectedFlagKey && changedKeys.has(selectedFlagKey)) {
        loadDetail(selectedFlagKey);
      }
    };

    client.on('featureFlags.changed', handleFlagChange);
    return () => {
      client.off('featureFlags.changed', handleFlagChange);
    };
  }, [client, loadFlags, selectedFlagKey]);

  // ==========================================================================
  // Detail loading
  // ==========================================================================

  const loadDetail = useCallback(
    async (key: string) => {
      setDetailLoading(true);
      try {
        const [flagResult, overridesResult] = await Promise.all([
          client.featureFlags.list().then((r) => r.flags.find((f) => f.key === key)),
          client.featureFlags.getOverrides(key),
        ]);

        if (flagResult) {
          setDetailFlag(flagResult);
          setDefaultValueDraft(flagResult.defaultValue);
          setHasDefaultChanged(false);
        }
        setOverrides(overridesResult.overrides);
      } catch (err: any) {
        toast.error(t('featureFlags.error'), err.message || t('featureFlags.failedToLoadDetail'));
      } finally {
        setDetailLoading(false);
      }
    },
    [client, toast],
  );

  const handleSelectFlag = (flag: FeatureFlagItem) => {
    setSelectedFlagKey(flag.key);
    setDetailFlag(flag);
    setDefaultValueDraft(flag.defaultValue);
    setHasDefaultChanged(false);
    setOverrides([]);
    setEditingOverride(null);
    setScreen('detail');
    loadDetail(flag.key);
  };

  const handleBackToList = () => {
    setScreen('list');
    setSelectedFlagKey(null);
    setDetailFlag(null);
    setEditingOverride(null);
  };

  // ==========================================================================
  // Confirmation helpers
  // ==========================================================================

  const openConfirmModal = useCallback(
    (flagKey: string, oldValue: unknown, newValue: unknown, type: string, onConfirm: () => void) => {
      setConfirmModal({
        open: true,
        flagKey,
        newValue,
        oldValue,
        type,
        onConfirm,
      });
    },
    [],
  );

  const closeConfirmModal = useCallback(() => {
    setConfirmModal((prev) => ({ ...prev, open: false }));
  }, []);

  // ==========================================================================
  // Default value management
  // ==========================================================================

  const handleSaveDefault = async () => {
    if (!detailFlag || defaultValueDraft === undefined) return;
    setSavingDefault(true);
    try {
      await client.featureFlags.update(detailFlag.key, defaultValueDraft as any);
      toast.success(t('featureFlags.saved'), t('featureFlags.defaultValueUpdated', { flagKey: detailFlag.key }));
      setHasDefaultChanged(false);
      // Refresh the flag in the list
      loadFlags();
    } catch (err: any) {
      toast.error(t('featureFlags.error'), err.message || t('featureFlags.failedToUpdateDefault'));
    } finally {
      setSavingDefault(false);
    }
  };

  const handleResetDefault = async () => {
    if (!detailFlag) return;
    setResettingDefault(true);
    try {
      await client.featureFlags.resetDefault(detailFlag.key);
      toast.success(t('featureFlags.reset'), t('featureFlags.resetToDefault', { flagKey: detailFlag.key }));
      setHasDefaultChanged(false);
      loadDetail(detailFlag.key);
      loadFlags();
    } catch (err: any) {
      toast.error(t('featureFlags.error'), err.message || t('featureFlags.failedToResetDefault'));
    } finally {
      setResettingDefault(false);
    }
  };

  // ==========================================================================
  // Override management
  // ==========================================================================

  const handleSaveOverrideEdit = async () => {
    if (!detailFlag || !editingOverride) return;
    setSavingOverride(true);
    try {
      await client.featureFlags.setOverride(
        detailFlag.key,
        editingOverride.targetType,
        editingOverride.targetId,
        editDraftValue as any,
        editDraftNote,
      );
      toast.success(t('featureFlags.saved'), t('featureFlags.overrideUpdated'));
      setEditingOverride(null);
      loadDetail(detailFlag.key);
      loadFlags();
    } catch (err: any) {
      toast.error(t('featureFlags.error'), err.message || t('featureFlags.failedToUpdateOverride'));
    } finally {
      setSavingOverride(false);
    }
  };

  const handleDeleteOverride = async (override: FeatureFlagOverrideItem) => {
    if (!detailFlag) return;
    setDeletingOverride(`${override.targetType}-${override.targetId}`);
    try {
      await client.featureFlags.deleteOverride(detailFlag.key, override.targetType, override.targetId);
      toast.success(t('featureFlags.deleted'), t('featureFlags.overrideRemoved'));
      setEditingOverride(null);
      loadDetail(detailFlag.key);
      loadFlags();
    } catch (err: any) {
      toast.error(t('featureFlags.error'), err.message || t('featureFlags.failedToDeleteOverride'));
    } finally {
      setDeletingOverride(null);
    }
  };

  const handleAddOverride = async () => {
    if (!detailFlag || addValue === undefined || !addTargetId.trim()) return;
    setAddSaving(true);
    try {
      await client.featureFlags.setOverride(
        detailFlag.key,
        addTargetType,
        addTargetId.trim(),
        addValue as any,
        addNote.trim() || undefined,
      );
      toast.success(t('featureFlags.created'), t('featureFlags.overrideAdded'));
      setShowAddModal(false);
      resetAddModal();
      loadDetail(detailFlag.key);
      loadFlags();
    } catch (err: any) {
      toast.error(t('featureFlags.error'), err.message || t('featureFlags.failedToCreateOverride'));
    } finally {
      setAddSaving(false);
    }
  };

  const resetAddModal = () => {
    setAddTargetType('workspace');
    setAddTargetId('');
    setAddValue(undefined);
    setAddNote('');
  };

  // ==========================================================================
  // Filtering
  // ==========================================================================

  const filteredFlags = useMemo(() => {
    if (!searchQuery.trim()) return flags;
    const q = searchQuery.toLowerCase();
    return flags.filter(
      (f) =>
        f.key.toLowerCase().includes(q) ||
        f.description?.toLowerCase().includes(q) ||
        f.category?.toLowerCase().includes(q),
    );
  }, [flags, searchQuery]);

  // ==========================================================================
  // Connection banner
  // ==========================================================================

  const ConnectionBanner = !connected ? (
    <XStack
      backgroundColor={indicators.risk.bg}
      borderBottomWidth={1}
      borderBottomColor={indicators.risk.border}
      paddingHorizontal="$3"
      paddingVertical="$1.5"
      alignItems="center"
      gap="$2"
    >
      <RefreshCcw size={14} color={semanticColors.amber} />
      <Text fontSize={12} color={semanticColors.amber}>
        {t('featureFlags.connectionLost')}
      </Text>
    </XStack>
  ) : null;

  // ==========================================================================
  // Error screen
  // ==========================================================================

  if (error && screen === 'list') {
    return (
      <YStack flex={1} backgroundColor={c.bgPage} justifyContent="center" alignItems="center" padding="$4">
        <Shield size={48} color={semanticColors.red} />
        <Text color={semanticColors.red} marginTop="$3" textAlign="center" fontWeight="600">
          {error}
        </Text>
        <Text color={c.text3} marginTop="$2" fontSize="$2" textAlign="center">
          {t('featureFlags.adminRequired')}
        </Text>
      </YStack>
    );
  }

  // ==========================================================================
  // LIST SCREEN
  // ==========================================================================

  if (screen === 'list') {
    return (
      <YStack flex={1} backgroundColor={c.bgPage}>
        {ConnectionBanner}

        {/* Header */}
        <YStack borderBottomWidth={1} borderBottomColor={isDark ? 'rgba(39, 39, 42, 0.6)' : c.bgInner}>
          <XStack
            paddingHorizontal="$3"
            paddingVertical="$2"
            justifyContent="space-between"
            alignItems="center"
          >
            <Text fontSize={16} fontWeight="600" color={c.text}>
              {t('featureFlags.title')}
            </Text>

            {/* Search */}
            <XStack
              backgroundColor={isDark ? 'rgba(39, 39, 42, 0.6)' : c.bgInner}
              borderRadius={6}
              paddingHorizontal="$2"
              paddingVertical="$1"
              alignItems="center"
              gap="$2"
              width={200}
              borderWidth={1}
              borderColor={c.borderStrong}
            >
              <Search size={12} color={c.text3} />
              <TextInput
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder={t('featureFlags.searchPlaceholder')}
                placeholderTextColor={c.text3}
                style={{
                  flex: 1,
                  color: c.text,
                  fontSize: 12,
                }}
              />
              {searchQuery ? (
                <TouchableOpacity onPress={() => setSearchQuery('')}>
                  <X size={12} color={c.text3} />
                </TouchableOpacity>
              ) : null}
            </XStack>
          </XStack>
        </YStack>

        {loading ? (
          <FullscreenLoader variant="default" label={t('featureFlags.loadingFlags')} />
        ) : (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, paddingBottom: 24 }}>
            {filteredFlags.length === 0 ? (
              <YStack alignItems="center" padding="$6" gap="$3">
                <Flag size={40} color={c.text3} />
                <Text color={c.text3} textAlign="center" fontSize={13}>
                  {searchQuery ? t('featureFlags.noFlagsMatch', { query: searchQuery }) : t('featureFlags.noFlagsRegistered')}
                </Text>
                {!searchQuery && (
                  <Text color={c.text3} textAlign="center" fontSize={12}>
                    {t('featureFlags.addFlagsHint')}
                  </Text>
                )}
              </YStack>
            ) : (
              <YStack gap="$2">
                {filteredFlags.map((flag) => (
                  <YStack
                    key={flag.key}
                    backgroundColor={flag.highlight ? (isDark ? 'rgba(245, 158, 11, 0.1)' : 'rgba(245, 158, 11, 0.06)') : c.bgCard}
                    borderRadius={8}
                    borderWidth={1}
                    borderColor={flag.highlight ? indicators.risk.border : c.border}
                    overflow="hidden"
                  >
                    {/* Card body: left info + right widget */}
                    <XStack padding="$3" gap="$3" alignItems="flex-start">
                      {/* Left: key, type badge, description */}
                      <YStack flex={1} gap="$1">
                        <XStack alignItems="center" gap="$2" flexWrap="wrap">
                          <Text fontSize={13} fontWeight="600" color={c.text} numberOfLines={1}>
                            {flag.key}
                          </Text>
                          <XStack
                            backgroundColor={`${getTypeColor(flag.type)}15`}
                            borderRadius={4}
                            paddingHorizontal="$1.5"
                            paddingVertical="$0.5"
                          >
                            <Text fontSize={10} color={getTypeColor(flag.type)} fontWeight="500">
                              {flag.type}
                            </Text>
                          </XStack>
                        </XStack>
                        {flag.description && (
                          <Text fontSize={11} color={c.text3} numberOfLines={2}>
                            {flag.description}
                          </Text>
                        )}
                      </YStack>

                      {/* Right: editable value widget */}
                      <YStack width={140} alignItems="flex-end" justifyContent="center">
                        <ValueWidget
                          type={flag.type}
                          enumValues={flag.enumValues}
                          value={flag.defaultValue}
                          onCommit={(newValue) => {
                            openConfirmModal(
                              flag.key,
                              flag.defaultValue,
                              newValue,
                              flag.type,
                              async () => {
                                try {
                                  await client.featureFlags.update(flag.key, newValue as any);
                                  toast.success(t('common.saved'), t('featureFlags.defaultValueUpdated', { flagKey: flag.key }));
                                  loadFlags();
                                } catch (err: any) {
                                  toast.error(t('common.error'), err.message || t('errors.featureFlags.updateDefaultFailed'));
                                }
                              },
                            );
                          }}
                          disabled={!connected}
                        />
                      </YStack>
                    </XStack>

                    {/* Divider + override link */}
                    <YStack
                      borderTopWidth={1}
                      borderTopColor={c.border}
                      backgroundColor={c.bgInner}
                    >
                      <TouchableOpacity
                        onPress={() => handleSelectFlag(flag)}
                        disabled={!connected}
                        activeOpacity={0.7}
                      >
                        <XStack
                          paddingHorizontal="$3"
                          paddingVertical="$2"
                          alignItems="center"
                          justifyContent="space-between"
                        >
                          {flag.overrideCount === 0 ? (
                            <XStack alignItems="center" gap="$1.5">
                              <Plus size={12} color={c.text3} />
                              <Text fontSize={11} color={c.text3} fontWeight="500">
                                {t('featureFlags.addOverride')}
                              </Text>
                            </XStack>
                          ) : (
                            <XStack alignItems="center" gap="$1.5">
                              <ChevronRight size={12} color={semanticColors.indigo} />
                              <Text fontSize={11} color={semanticColors.indigo} fontWeight="500">
                                {t('featureFlags.manageOverrides', { count: flag.overrideCount })}
                              </Text>
                            </XStack>
                          )}
                        </XStack>
                      </TouchableOpacity>
                    </YStack>
                  </YStack>
                ))}
              </YStack>
            )}
          </ScrollView>
        )}

        {/* Confirmation Modal */}
        <ConfirmValueModal
          open={confirmModal.open}
          onClose={closeConfirmModal}
          flagKey={confirmModal.flagKey}
          oldValue={confirmModal.oldValue}
          newValue={confirmModal.newValue}
          type={confirmModal.type}
          onConfirm={confirmModal.onConfirm}
        />
      </YStack>
    );
  }

  // ==========================================================================
  // DETAIL SCREEN
  // ==========================================================================

  return (
    <YStack flex={1} backgroundColor={c.bgPage}>
      {ConnectionBanner}

      {/* Header */}
      <XStack
        borderBottomWidth={1}
        borderBottomColor={isDark ? 'rgba(39, 39, 42, 0.6)' : c.bgInner}
        paddingHorizontal="$3"
        paddingVertical="$2"
        alignItems="center"
        gap="$2"
      >
        <Button
          size="$2"
          circular
          backgroundColor="transparent"
          hoverStyle={{ backgroundColor: isDark ? '#1a1a1a' : 'rgba(10,10,15,0.06)' }}
          onPress={handleBackToList}
          icon={<ArrowLeft size={16} color={c.text2} />}
        />
        <Text fontSize={16} fontWeight="600" color={c.text}>
          {detailFlag?.key || t('featureFlags.flagDetail')}
        </Text>
      </XStack>

      {detailLoading && !detailFlag ? (
        <FullscreenLoader variant="default" label={t('common.loading')} />
      ) : detailFlag ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
          <YStack gap="$4">
            {/* Flag info */}
            <YStack gap="$1">
              <XStack alignItems="center" gap="$2">
                <XStack
                  backgroundColor={`${getTypeColor(detailFlag.type)}15`}
                  borderRadius={4}
                  paddingHorizontal="$1.5"
                  paddingVertical="$0.5"
                >
                  <Text fontSize={10} color={getTypeColor(detailFlag.type)} fontWeight="500">
                    {detailFlag.type}
                  </Text>
                </XStack>
                {detailFlag.category && (
                  <Text fontSize={11} color={c.text3}>
                    {detailFlag.category}
                  </Text>
                )}
              </XStack>
              {detailFlag.description && (
                <Text fontSize={13} color={c.text2}>
                  {detailFlag.description}
                </Text>
              )}
            </YStack>

            {/* Global Default Section */}
            <YStack
              backgroundColor={c.bgCard}
              borderRadius={8}
              padding="$3"
              borderWidth={1}
              borderColor={c.border}
              gap="$3"
            >
              <Text fontSize={13} fontWeight="600" color={c.text}>
                {t('featureFlags.globalDefault')}
              </Text>

              <ValueInput
                type={detailFlag.type}
                enumValues={detailFlag.enumValues}
                value={defaultValueDraft}
                onChange={(v) => {
                  setDefaultValueDraft(v);
                  setHasDefaultChanged(true);
                }}
              />

              <XStack gap="$2" justifyContent="flex-end">
                <Button
                  size="$2"
                  backgroundColor="transparent"
                  borderWidth={1}
                  borderColor={c.borderStrong}
                  color={c.text2}
                  hoverStyle={{ backgroundColor: isDark ? '#1a1a1a' : 'rgba(10,10,15,0.06)' }}
                  onPress={handleResetDefault}
                  disabled={!connected || resettingDefault}
                  icon={resettingDefault ? undefined : <RefreshCcw size={14} color={c.text2} />}
                >
                  {resettingDefault ? <AppSpinner size="sm" /> : t('featureFlags.resetToRegistryDefault')}
                </Button>
                <Button
                  size="$2"
                  backgroundColor={hasDefaultChanged ? semanticColors.indigo : 'transparent'}
                  borderWidth={hasDefaultChanged ? 0 : 1}
                  borderColor={c.borderStrong}
                  color={hasDefaultChanged ? '#fff' : c.text3}
                  hoverStyle={{ backgroundColor: hasDefaultChanged ? semanticColors.indigoDark : isDark ? '#1a1a1a' : 'rgba(10,10,15,0.06)' }}
                  onPress={() => {
                    if (!detailFlag || defaultValueDraft === undefined) return;
                    openConfirmModal(
                      detailFlag.key,
                      detailFlag.defaultValue,
                      defaultValueDraft,
                      detailFlag.type,
                      handleSaveDefault,
                    );
                  }}
                  disabled={!connected || !hasDefaultChanged || savingDefault}
                  icon={savingDefault ? undefined : <Save size={14} color={hasDefaultChanged ? '#fff' : c.text3} />}
                >
                  {savingDefault ? <AppSpinner size="sm" /> : t('common.save')}
                </Button>
              </XStack>
            </YStack>

            {/* Overrides Section */}
            <YStack gap="$2">
              <XStack justifyContent="space-between" alignItems="center">
                <Text fontSize={13} fontWeight="600" color={c.text}>
                  {t('featureFlags.overrides')}
                </Text>
                <Button
                  size="$2"
                  backgroundColor={semanticColors.indigoGlow}
                  borderWidth={1}
                  borderColor={semanticColors.indigoGlow}
                  color={semanticColors.indigo}
                  hoverStyle={{ backgroundColor: semanticColors.indigoGlow }}
                  onPress={() => {
                    resetAddModal();
                    setAddValue(getDefaultForType(detailFlag.type));
                    setShowAddModal(true);
                  }}
                  disabled={!connected}
                  icon={<Plus size={14} color={semanticColors.indigo} />}
                >
                  {t('featureFlags.addOverrideButton')}
                </Button>
              </XStack>

              {overrides.length === 0 ? (
                <YStack
                  backgroundColor={c.bgCard}
                  borderRadius={8}
                  padding="$4"
                  borderWidth={1}
                  borderColor={c.border}
                  alignItems="center"
                >
                  <Text fontSize={13} color={c.text3} textAlign="center">
                    {t('featureFlags.noOverrides')}
                  </Text>
                </YStack>
              ) : (
                <YStack gap="$2">
                  {overrides.map((override) => {
                    const isEditing =
                      editingOverride?.targetType === override.targetType &&
                      editingOverride?.targetId === override.targetId;
                    const isDeleting =
                      deletingOverride === `${override.targetType}-${override.targetId}`;

                    return (
                      <YStack
                        key={`${override.targetType}-${override.targetId}`}
                        backgroundColor={c.bgCard}
                        borderRadius={8}
                        padding="$3"
                        borderWidth={1}
                        borderColor={c.border}
                        gap="$2"
                      >
                        {/* Target info */}
                        <XStack justifyContent="space-between" alignItems="center">
                          <XStack alignItems="center" gap="$2">
                            <XStack
                              backgroundColor={semanticColors.indigoGlow}
                              borderRadius={4}
                              paddingHorizontal="$1.5"
                              paddingVertical="$0.5"
                            >
                              <Text fontSize={10} color={semanticColors.indigo} fontWeight="500" textTransform="capitalize">
                                {override.targetType}
                              </Text>
                            </XStack>
                            <Text fontSize={13} color={c.text} fontWeight="500">
                              {override.targetId}
                            </Text>
                          </XStack>

                          {!isEditing && (
                            <XStack gap="$1">
                              <Button
                                size="$1"
                                circular
                                backgroundColor="transparent"
                                hoverStyle={{ backgroundColor: isDark ? '#1a1a1a' : 'rgba(10,10,15,0.06)' }}
                                onPress={() => {
                                  setEditingOverride(override);
                                  setEditDraftValue(override.value);
                                  setEditDraftNote(override.note || '');
                                }}
                                disabled={!connected}
                                icon={<Pencil size={14} color={c.text2} />}
                              />
                              <Button
                                size="$1"
                                circular
                                backgroundColor="transparent"
                                hoverStyle={{ backgroundColor: controlsBar.deny.bg }}
                                onPress={() => handleDeleteOverride(override)}
                                disabled={!connected || isDeleting}
                                icon={
                                  isDeleting ? (
                                    <AppSpinner size="sm" />
                                  ) : (
                                    <Trash2 size={14} color={semanticColors.red} />
                                  )
                                }
                              />
                            </XStack>
                          )}
                        </XStack>

                        {/* Value */}
                        {isEditing ? (
                          <YStack gap="$2">
                            <ValueInput
                              type={detailFlag.type}
                              enumValues={detailFlag.enumValues}
                              value={editDraftValue}
                              onChange={setEditDraftValue}
                            />
                            <TextInput
                              value={editDraftNote}
                              onChangeText={setEditDraftNote}
                              placeholder={t('featureFlags.noteOptional')}
                              placeholderTextColor={c.text3}
                              style={{
                                backgroundColor: isDark ? 'rgba(39, 39, 42, 0.6)' : c.bgInner,
                                borderRadius: 6,
                                paddingHorizontal: 10,
                                paddingVertical: 8,
                                color: c.text,
                                fontSize: 13,
                                borderWidth: 1,
                                borderColor: c.borderStrong,
                              }}
                            />
                            <XStack gap="$2" justifyContent="flex-end">
                              <Button
                                size="$2"
                                backgroundColor="transparent"
                                borderWidth={1}
                                borderColor={c.borderStrong}
                                color={c.text2}
                                onPress={() => setEditingOverride(null)}
                              >
                                {t('common.cancel')}
                              </Button>
                              <Button
                                size="$2"
                                backgroundColor={semanticColors.indigo}
                                color="#fff"
                                hoverStyle={{ backgroundColor: semanticColors.indigoDark }}
                                onPress={handleSaveOverrideEdit}
                                disabled={savingOverride}
                                icon={savingOverride ? undefined : <Save size={14} color="#fff" />}
                              >
                                {savingOverride ? <AppSpinner size="sm" /> : t('common.save')}
                              </Button>
                            </XStack>
                          </YStack>
                        ) : (
                          <YStack gap="$1">
                            <XStack alignItems="center" gap="$2">
                              <Text fontSize={12} color={c.text3}>
                                {t('featureFlags.valueLabel')}
                              </Text>
                              <Text fontSize={13} color={c.text}>
                                {formatValue(override.value, detailFlag.type)}
                              </Text>
                            </XStack>
                            {override.note && (
                              <Text fontSize={11} color={c.text3} fontStyle="italic">
                                {t('featureFlags.noteLabel', { note: override.note })}
                              </Text>
                            )}
                          </YStack>
                        )}
                      </YStack>
                    );
                  })}
                </YStack>
              )}
            </YStack>
          </YStack>
        </ScrollView>
      ) : null}

      {/* Add Override Modal */}
      <AddOverrideModal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        flagType={detailFlag?.type || 'boolean'}
        flagEnumValues={detailFlag?.enumValues}
        targetType={addTargetType}
        onTargetTypeChange={setAddTargetType}
        targetId={addTargetId}
        onTargetIdChange={setAddTargetId}
        value={addValue}
        onValueChange={setAddValue}
        note={addNote}
        onNoteChange={setAddNote}
        onSave={handleAddOverride}
        saving={addSaving}
        connected={connected}
      />

      {/* Confirmation Modal */}
      <ConfirmValueModal
        open={confirmModal.open}
        onClose={closeConfirmModal}
        flagKey={confirmModal.flagKey}
        oldValue={confirmModal.oldValue}
        newValue={confirmModal.newValue}
        type={confirmModal.type}
        onConfirm={confirmModal.onConfirm}
      />
    </YStack>
  );
}

// ============================================================================
// ValueWidget — Compact editable widget for list view
// ============================================================================

function ValueWidget({
  type,
  value,
  onCommit,
  disabled,
  enumValues,
}: {
  type: string;
  value: unknown;
  onCommit: (v: unknown) => void;
  disabled?: boolean;
  enumValues?: string[];
}) {
  const c = useColors();
  const isDark = c.bgPage === surface.dark.bgPage;
  // Local draft state for text inputs so we only commit on blur
  const [draft, setDraft] = useState(() =>
    value !== undefined ? (type === 'json' || type === 'default' ? JSON.stringify(value) : String(value)) : ''
  );

  // Keep draft in sync when external value changes
  useEffect(() => {
    if (value !== undefined) {
      if (type === 'json' || type === 'default') {
        setDraft(JSON.stringify(value));
      } else {
        setDraft(String(value));
      }
    }
  }, [value, type]);

  switch (type) {
    case 'boolean':
      return (
        <XStack alignItems="center" gap="$2">
          <Switch
            value={!!value}
            onValueChange={(v) => onCommit(v)}
            trackColor={{ false: isDark ? '#27272A' : 'rgba(10,10,15,0.05)', true: semanticColors.green }}
            thumbColor="#fff"
            disabled={disabled}
          />
          <Text fontSize={12} color={value ? semanticColors.green : c.text3} fontWeight="500">
            {value ? 'ON' : 'OFF'}
          </Text>
        </XStack>
      );

    case 'number': {
      const commitNumber = () => {
        const num = parseFloat(draft);
        onCommit(Number.isNaN(num) ? draft : num);
      };
      return (
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onBlur={commitNumber}
          onSubmitEditing={commitNumber}
          keyboardType="numeric"
          editable={!disabled}
          style={{
            backgroundColor: isDark ? 'rgba(39, 39, 42, 0.6)' : c.bgInner,
            borderRadius: 6,
            paddingHorizontal: 10,
            paddingVertical: 6,
            color: c.text,
            fontSize: 13,
            borderWidth: 1,
            borderColor: c.borderStrong,
            width: '100%',
            textAlign: 'right',
          }}
        />
      );
    }

    case 'string': {
      // Closed value set → segmented selector, commit on tap (TER-645/#1).
      if (enumValues && enumValues.length > 0) {
        return (
          <XStack gap="$1" flexWrap="wrap">
            {enumValues.map((opt) => {
              const selected = value === opt;
              return (
                <XStack
                  key={opt}
                  paddingHorizontal={10}
                  paddingVertical={4}
                  borderRadius={6}
                  backgroundColor={selected ? semanticColors.indigo : isDark ? 'rgba(39,39,42,0.6)' : c.bgInner}
                  borderColor={selected ? semanticColors.indigo : c.borderStrong}
                  borderWidth={1}
                  cursor={disabled ? undefined : 'pointer'}
                  opacity={disabled ? 0.5 : 1}
                  onPress={disabled ? undefined : () => onCommit(opt)}
                  aria-label={`Set value to ${opt}${selected ? ' (selected)' : ''}`}
                >
                  <Text fontSize={12} fontWeight={selected ? '600' : '400'} color={selected ? '#fff' : c.text}>
                    {opt}
                  </Text>
                </XStack>
              );
            })}
          </XStack>
        );
      }
      const commitString = () => onCommit(draft);
      return (
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onBlur={commitString}
          onSubmitEditing={commitString}
          editable={!disabled}
          style={{
            backgroundColor: isDark ? 'rgba(39, 39, 42, 0.6)' : c.bgInner,
            borderRadius: 6,
            paddingHorizontal: 10,
            paddingVertical: 6,
            color: c.text,
            fontSize: 13,
            borderWidth: 1,
            borderColor: c.borderStrong,
            width: '100%',
            textAlign: 'right',
          }}
        />
      );
    }

    default: {
      // JSON / fallback — compact textarea
      const commitJson = () => {
        try {
          onCommit(JSON.parse(draft));
        } catch {
          onCommit(draft);
        }
      };
      return (
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onBlur={commitJson}
          editable={!disabled}
          multiline
          numberOfLines={2}
          style={{
            backgroundColor: isDark ? 'rgba(39, 39, 42, 0.6)' : c.bgInner,
            borderRadius: 6,
            paddingHorizontal: 10,
            paddingVertical: 6,
            color: c.text,
            fontSize: 11,
            fontFamily: '$mono',
            borderWidth: 1,
            borderColor: c.borderStrong,
            width: '100%',
            textAlign: 'right',
            minHeight: 40,
          }}
        />
      );
    }
  }
}

// ============================================================================
// ValueInput — Full editable input for detail view
// ============================================================================

function ValueInput({
  type,
  value,
  onChange,
  enumValues,
}: {
  type: string;
  value: unknown;
  onChange: (v: unknown) => void;
  enumValues?: string[];
}) {
  const c = useColors();
  const isDark = c.bgPage === surface.dark.bgPage;
  const [stringValue, setStringValue] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);

  useEffect(() => {
    if (type === 'string[]') {
      if (Array.isArray(value)) {
        setStringValue((value as string[]).join(', '));
      }
    }
  }, [value, type]);

  switch (type) {
    case 'boolean':
      return (
        <XStack alignItems="center" gap="$3">
          <Switch
            value={!!value}
            onValueChange={onChange}
            trackColor={{ false: isDark ? '#27272A' : 'rgba(10,10,15,0.05)', true: semanticColors.green }}
            thumbColor="#fff"
          />
          <Text fontSize={13} color={c.text}>
            {value ? 'true' : 'false'}
          </Text>
        </XStack>
      );

    case 'number':
      return (
        <TextInput
          value={value !== undefined ? String(value) : ''}
          onChangeText={(text) => {
            const num = parseFloat(text);
            onChange(Number.isNaN(num) ? text : num);
          }}
          keyboardType="numeric"
          style={{
            backgroundColor: isDark ? 'rgba(39, 39, 42, 0.6)' : c.bgInner,
            borderRadius: 6,
            paddingHorizontal: 10,
            paddingVertical: 8,
            color: c.text,
            fontSize: 13,
            borderWidth: 1,
            borderColor: c.borderStrong,
          }}
        />
      );

    case 'string':
      // Closed value set (e.g. teros.fallback: off|on-error|cutover) → segmented
      // selector instead of free text, so the value can't be mistyped (TER-645/#1).
      if (enumValues && enumValues.length > 0) {
        return (
          <XStack gap="$2" flexWrap="wrap">
            {enumValues.map((opt) => {
              const selected = value === opt;
              return (
                <XStack
                  key={opt}
                  paddingHorizontal={14}
                  paddingVertical={7}
                  borderRadius={8}
                  backgroundColor={selected ? semanticColors.indigo : isDark ? 'rgba(39,39,42,0.6)' : c.bgInner}
                  borderColor={selected ? semanticColors.indigo : c.borderStrong}
                  borderWidth={1}
                  cursor="pointer"
                  hoverStyle={selected ? undefined : { borderColor: semanticColors.indigo }}
                  onPress={() => onChange(opt)}
                  aria-label={`Set value to ${opt}${selected ? ' (selected)' : ''}`}
                >
                  <Text fontSize={13} fontWeight={selected ? '600' : '400'} color={selected ? '#fff' : c.text}>
                    {opt}
                  </Text>
                </XStack>
              );
            })}
          </XStack>
        );
      }
      return (
        <TextInput
          value={value !== undefined ? String(value) : ''}
          onChangeText={onChange}
          style={{
            backgroundColor: isDark ? 'rgba(39, 39, 42, 0.6)' : c.bgInner,
            borderRadius: 6,
            paddingHorizontal: 10,
            paddingVertical: 8,
            color: c.text,
            fontSize: 13,
            borderWidth: 1,
            borderColor: c.borderStrong,
          }}
        />
      );

    case 'string[]':
      return (
        <YStack gap="$1">
          <TextInput
            value={stringValue}
            onChangeText={(text) => {
              setStringValue(text);
              const parts = text
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
              onChange(parts);
            }}
            placeholder={'Value (comma-separated)'}
            placeholderTextColor={c.text3}
            style={{
              backgroundColor: isDark ? 'rgba(39, 39, 42, 0.6)' : c.bgInner,
              borderRadius: 6,
              paddingHorizontal: 10,
              paddingVertical: 8,
              color: c.text,
              fontSize: 13,
              borderWidth: 1,
              borderColor: c.borderStrong,
            }}
          />
          <Text fontSize={10} color={c.text3}>
            Comma-separated values
          </Text>
        </YStack>
      );

    default:
      return (
        <TextInput
          value={value !== undefined ? JSON.stringify(value) : ''}
          onChangeText={(text) => {
            try {
              const parsed = JSON.parse(text);
              onChange(parsed);
              setJsonError(null);
            } catch {
              onChange(text);
              setJsonError('Invalid JSON');
            }
          }}
          style={{
            backgroundColor: isDark ? 'rgba(39, 39, 42, 0.6)' : c.bgInner,
            borderRadius: 6,
            paddingHorizontal: 10,
            paddingVertical: 8,
            color: c.text,
            fontSize: 13,
            fontFamily: '$mono',
            borderWidth: 1,
            borderColor: jsonError ? semanticColors.red : c.borderStrong,
          }}
        />
      );
  }
}

// ============================================================================
// ConfirmValueModal
// ============================================================================

function ConfirmValueModal({
  open,
  onClose,
  flagKey,
  oldValue,
  newValue,
  type,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  flagKey: string;
  oldValue: unknown;
  newValue: unknown;
  type: string;
  onConfirm: () => void;
}) {
  const c = useColors();
  const isDark = c.bgPage === surface.dark.bgPage;
  const [confirming, setConfirming] = useState(false);

  const handleConfirm = async () => {
    setConfirming(true);
    try {
      await onConfirm();
    } finally {
      setConfirming(false);
      onClose();
    }
  };

  return (
    <Sheet
      modal
      open={open}
      onOpenChange={(o: boolean) => {
        if (!o) onClose();
      }}
      snapPoints={[40]}
      dismissOnSnapToBottom
      zIndex={100000}
    >
      <Sheet.Overlay
        animation={"lazy" as any}
        enterStyle={{ opacity: 0 }}
        exitStyle={{ opacity: 0 }}
        backgroundColor={isDark ? 'rgba(0,0,0,0.8)' : 'rgba(0,0,0,0.5)'}
      />
      <Sheet.Frame
        backgroundColor={c.bgCard}
        borderTopLeftRadius={12}
        borderTopRightRadius={12}
        padding={20}
      >
        <Sheet.Handle backgroundColor={c.borderStrong} />

        <YStack gap="$4" marginTop="$2">
          <Text fontSize={16} fontWeight="600" color={c.text}>
            Cambiar valor
          </Text>

          <Text fontSize={13} color={c.text2} lineHeight={20}>
            ¿Cambiar{' '}
            <Text color={c.text} fontWeight="500">
              {flagKey}
            </Text>{' '}
            de{' '}
            <Text color={c.text} fontWeight="500">
              {formatValue(oldValue, type)}
            </Text>{' '}
            a{' '}
            <Text color={c.text} fontWeight="500">
              {formatValue(newValue, type)}
            </Text>
            ? Esto afectará a todos los usuarios que no tengan un override activo.
          </Text>

          <XStack gap="$2" justifyContent="flex-end" marginTop="$2">
            <Button
              size="$3"
              backgroundColor="transparent"
              borderWidth={1}
              borderColor={c.borderStrong}
              color={c.text2}
              onPress={onClose}
              disabled={confirming}
            >
              Cancelar
            </Button>
            <Button
              size="$3"
              backgroundColor={semanticColors.indigo}
              color="#fff"
              hoverStyle={{ backgroundColor: semanticColors.indigoDark }}
              onPress={handleConfirm}
              disabled={confirming}
              icon={confirming ? undefined : <Save size={14} color="#fff" />}
            >
              {confirming ? <AppSpinner size="sm" /> : 'Confirmar'}
            </Button>
          </XStack>
        </YStack>
      </Sheet.Frame>
    </Sheet>
  );
}

// ============================================================================
// AddOverrideModal
// ============================================================================

function AddOverrideModal({
  open,
  onClose,
  flagType,
  flagEnumValues,
  targetType,
  onTargetTypeChange,
  targetId,
  onTargetIdChange,
  value,
  onValueChange,
  note,
  onNoteChange,
  onSave,
  saving,
  connected,
}: {
  open: boolean;
  onClose: () => void;
  flagType: string;
  flagEnumValues?: string[];
  targetType: 'workspace' | 'user' | 'company';
  onTargetTypeChange: (t: 'workspace' | 'user' | 'company') => void;
  targetId: string;
  onTargetIdChange: (id: string) => void;
  value: unknown;
  onValueChange: (v: unknown) => void;
  note: string;
  onNoteChange: (n: string) => void;
  onSave: () => void;
  saving: boolean;
  connected: boolean;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const isDark = c.bgPage === surface.dark.bgPage;
  return (
    <Sheet
      modal
      open={open}
      onOpenChange={(o: boolean) => {
        if (!o) onClose();
      }}
      snapPoints={[60]}
      dismissOnSnapToBottom
      zIndex={100000}
    >
      <Sheet.Overlay
        animation={"lazy" as any}
        enterStyle={{ opacity: 0 }}
        exitStyle={{ opacity: 0 }}
        backgroundColor={isDark ? 'rgba(0,0,0,0.8)' : 'rgba(0,0,0,0.5)'}
      />
      <Sheet.Frame
        backgroundColor={c.bgCard}
        borderTopLeftRadius={12}
        borderTopRightRadius={12}
        padding={16}
      >
        <Sheet.Handle backgroundColor={c.borderStrong} />

        <XStack justifyContent="space-between" alignItems="center" marginBottom={16}>
          <Text fontSize={16} fontWeight="600" color={c.text}>
            Add Override
          </Text>
          <Button
            circular
            size="$2"
            backgroundColor="transparent"
            icon={<X size={16} color={c.text3} />}
            onPress={onClose}
          />
        </XStack>

        <ScrollView style={{ maxHeight: 500 }}>
          <YStack gap="$4">
            {/* Target Type */}
            <YStack gap="$1">
              <Text fontSize={12} fontWeight="500" color={c.text2}>
                Target Type <Text color={semanticColors.red}>*</Text>
              </Text>
              <XStack gap="$2">
                {(['workspace', 'user', 'company'] as const).map((type) => (
                  <TouchableOpacity
                    key={type}
                    onPress={() => onTargetTypeChange(type)}
                    activeOpacity={0.7}
                  >
                    <XStack
                      backgroundColor={targetType === type ? semanticColors.indigoGlow : isDark ? 'rgba(39, 39, 42, 0.6)' : c.bgInner}
                      borderRadius={6}
                      paddingHorizontal="$3"
                      paddingVertical="$2"
                      borderWidth={1}
                      borderColor={targetType === type ? semanticColors.indigo : c.borderStrong}
                      alignItems="center"
                      gap="$1"
                    >
                      {targetType === type && <Check size={12} color={semanticColors.indigo} />}
                      <Text
                        fontSize={13}
                        color={targetType === type ? semanticColors.indigo : c.text2}
                        textTransform="capitalize"
                      >
                        {type}
                      </Text>
                    </XStack>
                  </TouchableOpacity>
                ))}
              </XStack>
            </YStack>

            {/* Target ID */}
            <YStack gap="$1">
              <Text fontSize={12} fontWeight="500" color={c.text2}>
                {t(`featureFlags.${targetType}Id`)}{' '}
                <Text color={semanticColors.red}>*</Text>
              </Text>
              <TextInput
                value={targetId}
                onChangeText={onTargetIdChange}
                placeholder={`Enter ${targetType} ID`}
                placeholderTextColor={c.text3}
                style={{
                  backgroundColor: isDark ? 'rgba(39, 39, 42, 0.6)' : c.bgInner,
                  borderRadius: 6,
                  paddingHorizontal: 10,
                  paddingVertical: 8,
                  color: c.text,
                  fontSize: 13,
                  borderWidth: 1,
                  borderColor: c.borderStrong,
                }}
              />
            </YStack>

            {/* Value */}
            <YStack gap="$1">
              <Text fontSize={12} fontWeight="500" color={c.text2}>
                Value <Text color={semanticColors.red}>*</Text>
              </Text>
              <ValueInput type={flagType} enumValues={flagEnumValues} value={value} onChange={onValueChange} />
            </YStack>

            {/* Note */}
            <YStack gap="$1">
              <Text fontSize={12} fontWeight="500" color={c.text2}>
                Note
              </Text>
              <TextInput
                value={note}
                onChangeText={onNoteChange}
                placeholder={'Reason for this override...'}
                placeholderTextColor={c.text3}
                style={{
                  backgroundColor: isDark ? 'rgba(39, 39, 42, 0.6)' : c.bgInner,
                  borderRadius: 6,
                  paddingHorizontal: 10,
                  paddingVertical: 8,
                  color: c.text,
                  fontSize: 13,
                  borderWidth: 1,
                  borderColor: c.borderStrong,
                }}
              />
            </YStack>

            {/* Actions */}
            <XStack gap="$2" justifyContent="flex-end" marginTop="$2">
              <Button
                size="$3"
                backgroundColor="transparent"
                borderWidth={1}
                borderColor={c.borderStrong}
                color={c.text2}
                onPress={onClose}
              >
                Cancel
              </Button>
              <Button
                size="$3"
                backgroundColor={semanticColors.indigo}
                color="#fff"
                hoverStyle={{ backgroundColor: semanticColors.indigoDark }}
                onPress={onSave}
                disabled={!connected || !targetId.trim() || value === undefined || saving}
                icon={saving ? undefined : <Save size={14} color="#fff" />}
              >
                {saving ? <AppSpinner size="sm" /> : 'Save Override'}
              </Button>
            </XStack>
          </YStack>
        </ScrollView>
      </Sheet.Frame>
    </Sheet>
  );
}
