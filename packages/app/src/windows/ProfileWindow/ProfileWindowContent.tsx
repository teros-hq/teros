/**
 * ProfileWindowContent - Contenido de la ventana de perfil
 *
 * Premium design with animated avatar, carousel badges and stats.
 * Includes edit mode for modifying the profile.
 */

import {
  ArrowLeft,
  Check,
  ChevronRight,
  Clock,
  CreditCard,
  Edit3,
  FileText,
  Globe,
  HelpCircle,
  LogOut,
  MessageSquare,
  Save,
  User,
  Users,
} from '@tamagui/lucide-icons';
import { LinearGradient } from 'expo-linear-gradient';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, TouchableOpacity } from 'react-native';
import { useTranslation } from "react-i18next";
import { Button, Input, Text, TextArea, XStack, YStack } from 'tamagui';
import i18n, { SUPPORTED_LOCALES, LOCALE_LABELS, type SupportedLocale } from "../../i18n";
import { getTerosClient } from '../../services/terosClientSingleton';
import { useAuthStore } from '../../store/authStore';
import { useTilingStore } from '../../store/tilingStore';
import type { ProfileWindowProps } from './definition';
import { AppSpinner, FullscreenLoader } from '../../components/ui';
import { ProfilePlanSection } from './ProfilePlanSection';
import { useColors } from '../../components/mca/primitives/useColors';
import { colors as semanticColors, surface } from '../../components/mca/primitives/colors';

// Semantic accents — theme-agnostic (same hex in light and dark)
const ACCENT = '#06B6D4'; // Brand cyan — no semantic token equivalent
const ACCENT_DARK = '#0891B2'; // Selected-state variant
const PINK = '#EC4899'; // Help icon accent — no semantic token equivalent
const RED = semanticColors.red;
const GREEN = semanticColors.green;
const AMBER = semanticColors.amber;
const VIOLET = semanticColors.violet;

interface Props extends ProfileWindowProps {
  windowId: string;
}

// Badge data type
interface Badge {
  id: string;
  titleKey: string;
  descriptionKey: string;
  reasonKey: string;
  imageUrl: string;
  gradientColors: [string, string];
  borderColor: string;
  backgroundColors: [string, string];
}

// Backend URL for static assets
const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL;

// Achievement badges - mapped to kawaii images
const BADGES: Badge[] = [
  // === Status Badges ===
  {
    id: 'founder',
    titleKey: 'badges.founder.title',
    descriptionKey: 'badges.founder.description',
    reasonKey: 'badges.founder.reason',
    imageUrl: `${BACKEND_URL}/static/badges/kawaii-v1/05-lion-rockstar.webp`,
    gradientColors: ['#8B5CF6', '#7C3AED'],
    borderColor: 'rgba(139, 92, 246, 0.3)',
    backgroundColors: ['rgba(139, 92, 246, 0.1)', 'rgba(124, 58, 237, 0.08)'],
  },
  {
    id: 'early-adopter',
    titleKey: 'badges.earlyAdopter.title',
    descriptionKey: 'badges.earlyAdopter.description',
    reasonKey: 'badges.earlyAdopter.reason',
    imageUrl: `${BACKEND_URL}/static/badges/kawaii-v1/02-fox-programmer.webp`,
    gradientColors: ['#F59E0B', '#D97706'],
    borderColor: 'rgba(245, 158, 11, 0.3)',
    backgroundColors: ['rgba(245, 158, 11, 0.1)', 'rgba(217, 119, 6, 0.08)'],
  },

  // === Usage Badges ===
  {
    id: 'first-steps',
    titleKey: 'badges.firstSteps.title',
    descriptionKey: 'badges.firstSteps.description',
    reasonKey: 'badges.firstSteps.reason',
    imageUrl: `${BACKEND_URL}/static/badges/kawaii-v1/01-koala-barista.webp`,
    gradientColors: ['#06B6D4', '#0891B2'],
    borderColor: 'rgba(6, 182, 212, 0.3)',
    backgroundColors: ['rgba(6, 182, 212, 0.1)', 'rgba(8, 145, 178, 0.08)'],
  },
  {
    id: 'power-user',
    titleKey: 'badges.powerUser.title',
    descriptionKey: 'badges.powerUser.description',
    reasonKey: 'badges.powerUser.reason',
    imageUrl: `${BACKEND_URL}/static/badges/kawaii-v1/04-octopus-dj.webp`,
    gradientColors: ['#EC4899', '#DB2777'],
    borderColor: 'rgba(236, 72, 153, 0.3)',
    backgroundColors: ['rgba(236, 72, 153, 0.1)', 'rgba(219, 39, 119, 0.08)'],
  },
  {
    id: 'super-user',
    titleKey: 'badges.superUser.title',
    descriptionKey: 'badges.superUser.description',
    reasonKey: 'badges.superUser.reason',
    imageUrl: `${BACKEND_URL}/static/badges/kawaii-v1/07-shark-surfer.webp`,
    gradientColors: ['#3B82F6', '#2563EB'],
    borderColor: 'rgba(59, 130, 246, 0.3)',
    backgroundColors: ['rgba(59, 130, 246, 0.1)', 'rgba(37, 99, 235, 0.08)'],
  },

  // === Contribution Badges ===
  {
    id: 'bug-hunter',
    titleKey: 'badges.bugHunter.title',
    descriptionKey: 'badges.bugHunter.description',
    reasonKey: 'badges.bugHunter.reason',
    imageUrl: `${BACKEND_URL}/static/badges/kawaii-v1/08-frog-scientist.webp`,
    gradientColors: ['#84CC16', '#65A30D'],
    borderColor: 'rgba(132, 204, 22, 0.3)',
    backgroundColors: ['rgba(132, 204, 22, 0.1)', 'rgba(101, 163, 13, 0.08)'],
  },
  {
    id: 'feature-requester',
    titleKey: 'badges.visionary.title',
    descriptionKey: 'badges.visionary.description',
    reasonKey: 'badges.visionary.reason',
    imageUrl: `${BACKEND_URL}/static/badges/kawaii-v1/03-owl-wizard.webp`,
    gradientColors: ['#8B5CF6', '#7C3AED'],
    borderColor: 'rgba(139, 92, 246, 0.3)',
    backgroundColors: ['rgba(139, 92, 246, 0.1)', 'rgba(124, 58, 237, 0.08)'],
  },
  {
    id: 'beta-tester',
    titleKey: 'badges.betaTester.title',
    descriptionKey: 'badges.betaTester.description',
    reasonKey: 'badges.betaTester.reason',
    imageUrl: `${BACKEND_URL}/static/badges/kawaii-v1/06-panda-chef.webp`,
    gradientColors: ['#10B981', '#059669'],
    borderColor: 'rgba(16, 185, 129, 0.3)',
    backgroundColors: ['rgba(16, 185, 129, 0.1)', 'rgba(5, 150, 105, 0.08)'],
  },
];

// Helper: calculate days since a date string
function daysSince(dateStr: string): number {
  const created = new Date(dateStr).getTime();
  const now = Date.now();
  return Math.floor((now - created) / (1000 * 60 * 60 * 24));
}

// Animated ring component for web
const AnimatedRing = () => {
  const c = useColors();
  if (Platform.OS !== 'web') {
    return (
      <XStack
        position="absolute"
        top={-4}
        left={-4}
        right={-4}
        bottom={-4}
        borderRadius={64}
        borderWidth={3}
        borderColor={ACCENT}
        opacity={0.8}
      />
    );
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: -4,
        left: -4,
        right: -4,
        bottom: -4,
        borderRadius: 64,
        background:
          'conic-gradient(from 0deg, #06B6D4, #8B5CF6, #EC4899, #F59E0B, #10B981, #06B6D4)',
        animation: 'spin 8s linear infinite',
        opacity: 0.8,
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 3,
          left: 3,
          right: 3,
          bottom: 3,
          borderRadius: 60,
          background: c.bgPage,
        }}
      />
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};

// Editable field component
interface EditableFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  icon: React.ReactNode;
  placeholder?: string;
  multiline?: boolean;
  maxLength?: number;
}

function EditableField({
  label,
  value,
  onChange,
  icon,
  placeholder,
  multiline,
  maxLength,
}: EditableFieldProps) {
  const c = useColors();
  return (
    <YStack gap="$2">
      <XStack alignItems="center" gap="$2">
        {icon}
        <Text fontSize={12} color={c.text2} textTransform="uppercase" letterSpacing={1}>
          {label}
        </Text>
      </XStack>
      {multiline ? (
        <TextArea
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          backgroundColor={c.bgInner}
          borderColor={c.borderStrong}
          borderWidth={1}
          borderRadius={12}
          color={c.text}
          placeholderTextColor={c.text3}
          padding="$3"
          minHeight={100}
          maxLength={maxLength}
          fontSize={14}
        />
      ) : (
        <Input
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          backgroundColor={c.bgInner}
          borderColor={c.borderStrong}
          borderWidth={1}
          borderRadius={12}
          color={c.text}
          placeholderTextColor={c.text3}
          height={48}
          paddingHorizontal="$3"
          maxLength={maxLength}
          fontSize={14}
        />
      )}
      {maxLength && (
        <Text fontSize={11} color={c.text3} textAlign="right">
          {value.length}/{maxLength}
        </Text>
      )}
    </YStack>
  );
}

export function ProfileWindowContent({ windowId, onLogout, initialMode }: Props) {
  const { t } = useTranslation();
  const c = useColors();
  const isDark = c.bgPage === surface.dark.bgPage;
  const { user, logout, updateProfile } = useAuthStore();
  const client = getTerosClient();
  const { openWindow } = useTilingStore();
  const [activeIndex, setActiveIndex] = useState(0);
  const carouselRef = useRef<ScrollView>(null);

  // View mode: 'view', 'edit' or 'plan' (billing). Can be opened straight on a
  // section via the initialMode prop (e.g. 'plan' from the hours-exhausted CTA).
  const [mode, setMode] = useState<'view' | 'edit' | 'plan'>(initialMode ?? 'view');
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stats state
  const [channelCount, setChannelCount] = useState<number | null>(null);
  const [agentCount, setAgentCount] = useState<number | null>(null);

  // Badges from profile
  const [userBadges, setUserBadges] = useState<Array<'founding_partner' | 'early_bird'>>([]);

  // Form state for edit mode
  const [displayName, setDisplayName] = useState(user?.name || '');
  const [description, setDescription] = useState(user?.description || '');
  const [locale, setLocale] = useState(user?.locale || '');
  const [timezone, setTimezone] = useState(user?.timezone || '');

  // Load profile and stats on mount — each call is independent so a stats
  // failure never prevents the profile from rendering (and vice-versa).
  // If the WebSocket is not yet connected we wait for the "connected" event
  // before making the requests (handles hard-reload with profile open).
  useEffect(() => {
    let cancelled = false;

    /** Wait until the WS client is connected, then resolve. */
    function waitForConnection(): Promise<void> {
      if (client.isConnected()) return Promise.resolve();
      return new Promise((resolve) => {
        const onConnected = () => {
          client.off('connected', onConnected);
          resolve();
        };
        client.on('connected', onConnected);
      });
    }

    async function loadProfile() {
      try {
        await waitForConnection();
        if (cancelled) return;
        const profile = await client.profile.getProfile();
        if (cancelled) return;
        updateProfile({
          name: profile.displayName,
          avatarUrl: profile.avatarUrl,
          description: profile.description,
          locale: profile.locale,
          timezone: profile.timezone,
          createdAt: profile.createdAt,
        });
        setDisplayName(profile.displayName || '');
        setDescription(profile.description || '');
        setLocale(profile.locale || '');
        setTimezone(profile.timezone || '');
        setUserBadges(profile.badges ?? []);
      } catch (err) {
        console.error('Failed to load profile:', err);
      }
    }

    async function loadStats() {
      try {
        await waitForConnection();
        if (cancelled) return;
        const stats = await client.profile.getStats();
        if (cancelled) return;
        setChannelCount(stats.channelCount);
        setAgentCount(stats.agentCount);
      } catch (err) {
        console.error('Failed to load stats:', err);
      }
    }

    async function loadProfileAndStats() {
      // Run both independently — a failure in one does not affect the other.
      await Promise.all([loadProfile(), loadStats()]);
      if (!cancelled) setIsLoading(false);
    }

    loadProfileAndStats();

    return () => {
      cancelled = true;
    };
  }, []);

  // Sync form when entering edit mode
  useEffect(() => {
    if (mode === 'edit' && user) {
      setDisplayName(user.name || '');
      setDescription(user.description || '');
      setLocale(user.locale || '');
      setTimezone(user.timezone || '');
    }
  }, [mode]);

  const handleLogout = async () => {
    await logout();
    onLogout?.();
  };

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);

    // Capture original locale before saving to detect changes
    const originalLocale = user?.locale;

    try {
      const profile = await client.profile.updateProfile({
        displayName: displayName.trim() || undefined,
        description: description.trim() || undefined,
        locale: locale.trim() || undefined,
        timezone: timezone.trim() || undefined,
      });

      updateProfile({
        name: profile.displayName,
        avatarUrl: profile.avatarUrl,
        description: profile.description,
        locale: profile.locale,
        timezone: profile.timezone,
      });

      setIsSaving(false);
      setSaveSuccess(true);

      // If locale changed, apply immediately via i18n and reload to flush all state
      if (profile.locale && profile.locale !== originalLocale) {
        i18n.changeLanguage(profile.locale);
        setTimeout(() => {
          if (Platform.OS === 'web') {
            // Web: full page reload flushes all cached strings
            window.location.reload();
          } else {
            // Native: i18n.changeLanguage() is reactive — UI updates without reload.
            // expo-updates reloadAsync() is intentionally NOT used here: it would
            // restart the JS bundle and lose all in-memory state. The reactive
            // i18n update is sufficient for native.
            setSaveSuccess(false);
            setMode('view');
          }
        }, 500);
      } else {
        setTimeout(() => {
          setSaveSuccess(false);
          setMode('view');
        }, 1000);
      }
    } catch (err) {
      console.error('Failed to update profile:', err);
      setError(t("profile.saveError"));
      setIsSaving(false);
    }
  };

  if (!user) {
    return (
      <YStack flex={1} padding="$4" alignItems="center" justifyContent="center">
        <Text color={c.text2}>{t("profile.noActiveSession")}</Text>
      </YStack>
    );
  }

  if (isLoading) {
    return (
      <FullscreenLoader label={t('profile.loadingProfile')} />
    );
  }

  const initials =
    user.name || displayName
      ? (user.name || displayName)
          .split(' ')
          .map((n) => n[0])
          .join('')
          .toUpperCase()
          .slice(0, 2)
      : user.email[0].toUpperCase();

  const visibleBadges = BADGES.filter((badge) => {
    if (badge.id === 'founder') return userBadges.includes('founding_partner');
    if (badge.id === 'early-adopter') return userBadges.includes('early_bird');
    return false;
  });

  const handleScroll = (event: any) => {
    const scrollX = event.nativeEvent.contentOffset.x;
    const cardWidth = event.nativeEvent.layoutMeasurement.width - 48;
    const newIndex = Math.round(scrollX / cardWidth);
    if (newIndex !== activeIndex && newIndex >= 0 && newIndex < visibleBadges.length) {
      setActiveIndex(newIndex);
    }
  };

  const scrollToIndex = (index: number) => {
    carouselRef.current?.scrollTo({ x: index * 320, animated: true });
    setActiveIndex(index);
  };

  const getStatIconColor = (color: string) => {
    switch (color) {
      case 'cyan':
        return ACCENT;
      case 'purple':
        return VIOLET;
      case 'amber':
        return AMBER;
      default:
        return c.text2;
    }
  };

  const getStatBgColor = (color: string) => {
    switch (color) {
      case 'cyan':
        return 'rgba(6, 182, 212, 0.15)';
      case 'purple':
        return 'rgba(139, 92, 246, 0.15)';
      case 'amber':
        return 'rgba(245, 158, 11, 0.15)';
      default:
        return isDark ? 'rgba(113, 113, 122, 0.15)' : 'rgba(74, 74, 90, 0.12)';
    }
  };

  const memberSince = user.createdAt
    ? new Date(user.createdAt).toLocaleDateString(i18n.language, { month: 'long', year: 'numeric' })
    : '';

  // Derived stats array with real data
  const daysOnPlatform = user.createdAt ? daysSince(user.createdAt) : 0;
  const STATS = [
    { value: channelCount !== null ? String(channelCount) : '–', label: t('profile.statChats'), icon: MessageSquare, color: 'cyan' },
    { value: agentCount !== null ? String(agentCount) : '–', label: t('profile.statAgents'), icon: Users, color: 'purple' },
    { value: String(daysOnPlatform), label: t('profile.statDays'), icon: Clock, color: 'amber' },
  ];

  // ========================================
  // PLAN / BILLING MODE
  // ========================================
  if (mode === 'plan') {
    return <ProfilePlanSection onBack={() => setMode('view')} />;
  }

  // ========================================
  // EDIT MODE
  // ========================================
  if (mode === 'edit') {
    return (
      <YStack flex={1} backgroundColor={c.bgPage}>
        <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
          {/* Header */}
          <XStack paddingHorizontal={24} paddingTop={20} paddingBottom={16} alignItems="center">
            <Button
              size="$3"
              circular
              backgroundColor={c.bgInner}
              borderWidth={0}
              onPress={() => setMode('view')}
              pressStyle={{ backgroundColor: c.bgCardHover }}
            >
              <ArrowLeft size={20} color={c.text} />
            </Button>
            <Text flex={1} textAlign="center" fontSize={18} fontWeight="600" color={c.text}>
              {t('profile.editProfile')}
            </Text>
            <Button
              size="$3"
              circular
              backgroundColor={saveSuccess ? 'rgba(34,197,94,0.2)' : 'rgba(6, 182, 212, 0.15)'}
              borderWidth={0}
              onPress={handleSave}
              disabled={isSaving}
              pressStyle={{ backgroundColor: 'rgba(6, 182, 212, 0.25)' }}
            >
              {isSaving ? (
                <AppSpinner size="sm" variant="brand" />
              ) : saveSuccess ? (
                <Check size={20} color={GREEN} />
              ) : (
                <Save size={20} color={ACCENT} />
              )}
            </Button>
          </XStack>

          {/* Error message */}
          {error && (
            <YStack
              marginHorizontal={24}
              marginBottom={16}
              padding={12}
              backgroundColor="rgba(239, 68, 68, 0.1)"
              borderWidth={1}
              borderColor="rgba(239, 68, 68, 0.2)"
              borderRadius={8}
            >
              <Text fontSize={13} color={RED}>
                {error}
              </Text>
            </YStack>
          )}

          {/* Avatar preview */}
          <YStack alignItems="center" paddingVertical={24}>
            <XStack
              width={80}
              height={80}
              borderRadius={40}
              backgroundColor={isDark ? '#1a1a2e' : c.bgCardHover}
              alignItems="center"
              justifyContent="center"
              borderWidth={2}
              borderColor={ACCENT}
            >
              {user.avatarUrl ? (
                <img
                  src={user.avatarUrl}
                  alt={displayName || 'Avatar'}
                  style={{ width: '100%', height: '100%', borderRadius: 40, objectFit: 'cover' }}
                />
              ) : (
                <Text fontSize={28} fontWeight="600" color={ACCENT}>
                  {initials}
                </Text>
              )}
            </XStack>
          </YStack>

          {/* Form Fields */}
          <YStack paddingHorizontal={24} gap={20}>
            <EditableField
              label={t('profile.labelName')}
              value={displayName}
              onChange={setDisplayName}
              icon={<User size={14} color={c.text2} />}
              placeholder={t('profile.namePlaceholder')}
              maxLength={100}
            />

            <EditableField
              label={t('profile.labelDescription')}
              value={description}
              onChange={setDescription}
              icon={<FileText size={14} color={c.text2} />}
              placeholder={t('profile.descriptionPlaceholder')}
              multiline
              maxLength={1000}
            />

            {/* Language picker — fixed list of supported locales */}
            <YStack gap={6}>
              <XStack alignItems="center" gap={6}>
                <Globe size={14} color={c.text2} />
                <Text fontSize={12} color={c.text2} fontWeight="500">
                  {t('profile.labelLanguage')}
                </Text>
              </XStack>
              <XStack gap={8} flexWrap="wrap">
                {SUPPORTED_LOCALES.map((loc) => {
                  const isSelected = locale === loc;
                  return (
                    <TouchableOpacity
                      key={loc}
                      onPress={() => setLocale(loc as SupportedLocale)}
                      style={{
                        paddingHorizontal: 14,
                        paddingVertical: 7,
                        borderRadius: 8,
                        borderWidth: 1,
                        borderColor: isSelected ? ACCENT_DARK : c.borderStrong,
                        backgroundColor: isSelected ? 'rgba(8,145,178,0.15)' : 'transparent',
                      }}
                    >
                      <Text
                        fontSize={13}
                        color={isSelected ? ACCENT : c.text2}
                        fontWeight={isSelected ? '600' : '400'}
                      >
                        {LOCALE_LABELS[loc]}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </XStack>
            </YStack>

            <EditableField
              label={t('profile.labelTimezone')}
              value={timezone}
              onChange={setTimezone}
              icon={<Clock size={14} color={c.text2} />}
              placeholder={t('profile.timezonePlaceholder')}
              maxLength={50}
            />
          </YStack>

          {/* Info box */}
          <YStack
            marginHorizontal={24}
            marginTop={24}
            marginBottom={40}
            padding={16}
            backgroundColor="rgba(6, 182, 212, 0.05)"
            borderWidth={1}
            borderColor="rgba(6, 182, 212, 0.1)"
            borderRadius={12}
          >
            <Text fontSize={13} color={c.text2} lineHeight={20}>
              💡 {t('profile.descriptionHint')}
            </Text>
          </YStack>
        </ScrollView>
      </YStack>
    );
  }

  // ========================================
  // VIEW MODE (Original beautiful design)
  // ========================================
  return (
    <YStack flex={1} backgroundColor={c.bgPage}>
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
        {/* Header with Avatar */}
        <YStack paddingTop={48} paddingBottom={40} paddingHorizontal={24} alignItems="center">
          {/* Avatar with animated ring */}
          <YStack
            width={128}
            height={128}
            marginBottom={24}
            alignItems="center"
            justifyContent="center"
          >
            <AnimatedRing />

            <XStack
              width={120}
              height={120}
              borderRadius={60}
              backgroundColor={isDark ? '#1a1a2e' : c.bgCardHover}
              alignItems="center"
              justifyContent="center"
              zIndex={1}
            >
              {user.avatarUrl ? (
                <img
                  src={user.avatarUrl}
                  alt={user.name || 'Avatar'}
                  style={{ width: '100%', height: '100%', borderRadius: 60, objectFit: 'cover' }}
                />
              ) : (
                <Text fontSize={42} fontWeight="600" color={ACCENT} letterSpacing={2}>
                  {initials}
                </Text>
              )}
            </XStack>

            {/* Online Status */}
            <XStack
              position="absolute"
              bottom={4}
              right={4}
              width={24}
              height={24}
              backgroundColor={GREEN}
              borderRadius={12}
              borderWidth={3}
              borderColor={c.bgPage}
              zIndex={2}
            />
          </YStack>

          {/* Name & Email */}
          <Text fontSize={28} fontWeight="600" color={c.text} marginBottom={4}>
            {user.name || t('profile.fallbackName')}
          </Text>
          <Text fontSize={14} color={c.text2}>
            {user.email}
          </Text>
          <Text fontSize={12} color={c.text3} marginTop={4}>
            {t('profile.memberSince', { date: memberSince })}
          </Text>
        </YStack>

        {/* Badge Carousel - shown only if user has badges */}
        {visibleBadges.length > 0 && (
          <YStack marginBottom={24}>
            <ScrollView
              ref={carouselRef}
              horizontal
              showsHorizontalScrollIndicator={false}
              snapToInterval={320}
              decelerationRate="fast"
              contentContainerStyle={{ paddingHorizontal: 24, gap: 12 }}
              onScroll={handleScroll}
              scrollEventThrottle={16}
            >
              {visibleBadges.map((badge) => (
                <LinearGradient
                  key={badge.id}
                  colors={badge.backgroundColors}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={{
                    width: 320,
                    borderRadius: 20,
                    borderWidth: 1,
                    borderColor: badge.borderColor,
                    padding: 20,
                  }}
                >
                  <XStack gap={16} alignItems="flex-start">
                    <XStack
                      width={72}
                      height={72}
                      borderRadius={16}
                      backgroundColor="rgba(255,255,255,0.95)"
                      alignItems="center"
                      justifyContent="center"
                      overflow="hidden"
                      borderWidth={2}
                      borderColor={badge.borderColor}
                    >
                      {Platform.OS === 'web' ? (
                        <img 
                          src={badge.imageUrl} 
                          alt={t(badge.titleKey)}
                          style={{ 
                            width: 64, 
                            height: 64, 
                            objectFit: 'contain',
                          }}
                        />
                      ) : (
                        <YStack width={64} height={64} backgroundColor="rgba(255,255,255,0.5)" borderRadius={8} />
                      )}
                    </XStack>
                    
                    <YStack flex={1}>
                      <Text fontSize={18} fontWeight="600" color={c.text} marginBottom={4}>
                        {t(badge.titleKey)}
                      </Text>
                      <Text fontSize={13} color={c.text2} lineHeight={20}>
                        {t(badge.descriptionKey)}
                      </Text>
                    </YStack>
                  </XStack>
                  
                  <YStack 
                    marginTop={16} 
                    paddingTop={14} 
                    borderTopWidth={1} 
                    borderTopColor={c.border}
                  >
                    <Text 
                      fontSize={11} 
                      color={c.text3} 
                      textTransform="uppercase" 
                      letterSpacing={1}
                    >
                      {t(badge.reasonKey)}
                    </Text>
                  </YStack>
                </LinearGradient>
              ))}
            </ScrollView>
            
            {visibleBadges.length > 1 && (
              <XStack justifyContent="center" gap={8} marginTop={16}>
                {visibleBadges.map((_, index) => (
                  <XStack
                    key={index}
                    width={activeIndex === index ? 24 : 8}
                    height={8}
                    borderRadius={4}
                    backgroundColor={activeIndex === index ? ACCENT : c.borderStrong}
                    pressStyle={{ opacity: 0.8 }}
                    onPress={() => scrollToIndex(index)}
                    cursor="pointer"
                  />
                ))}
              </XStack>
            )}
          </YStack>
        )}

        {/* Stats Grid */}
        <YStack paddingHorizontal={24} marginBottom={24}>
          <XStack gap={12}>
            {STATS.map((stat) => (
              <YStack
                key={stat.label}
                flex={1}
                backgroundColor={c.bgInner}
                borderWidth={1}
                borderColor={c.border}
                borderRadius={16}
                padding={16}
                alignItems="center"
                pressStyle={{ backgroundColor: c.bgCardHover }}
              >
                <XStack
                  width={36}
                  height={36}
                  borderRadius={10}
                  backgroundColor={getStatBgColor(stat.color)}
                  alignItems="center"
                  justifyContent="center"
                  marginBottom={10}
                >
                  <stat.icon size={18} color={getStatIconColor(stat.color)} />
                </XStack>
                <Text fontSize={22} fontWeight="700" color={c.text} marginBottom={2}>
                  {stat.value}
                </Text>
                <Text fontSize={10} color={c.text2} textTransform="uppercase" letterSpacing={0.5}>
                  {stat.label}
                </Text>
              </YStack>
            ))}
          </XStack>
        </YStack>

        {/* Spacer */}
        <YStack flex={1} minHeight={40} />

        {/* Bottom Section */}
        <YStack padding={24} gap={16}>
          {/* Edit Profile Button */}
          <YStack
            backgroundColor={c.bgInner}
            borderWidth={1}
            borderColor={c.border}
            borderRadius={16}
            overflow="hidden"
          >
            <XStack
              padding={16}
              alignItems="center"
              pressStyle={{ backgroundColor: c.bgCardHover }}
              cursor="pointer"
              onPress={() => setMode('edit')}
            >
              <XStack
                width={40}
                height={40}
                borderRadius={10}
                backgroundColor="rgba(6, 182, 212, 0.15)"
                alignItems="center"
                justifyContent="center"
                marginRight={14}
              >
                <Edit3 size={20} color={ACCENT} />
              </XStack>
              <YStack flex={1}>
                <Text fontSize={15} color={c.text} fontWeight="500" marginBottom={2}>
                  {t('profile.editProfile')}
                </Text>
                <Text fontSize={12} color={c.text2}>
                  {t('profile.editProfileSub')}
                </Text>
              </YStack>
              <ChevronRight size={18} color={c.text3} />
            </XStack>
          </YStack>

          {/* Plan & Billing Button */}
          <YStack
            backgroundColor={c.bgInner}
            borderWidth={1}
            borderColor={c.border}
            borderRadius={16}
            overflow="hidden"
          >
            <XStack
              testID="profile-open-plan"
              padding={16}
              alignItems="center"
              pressStyle={{ backgroundColor: c.bgCardHover }}
              cursor="pointer"
              onPress={() => setMode('plan')}
            >
              <XStack
                width={40}
                height={40}
                borderRadius={10}
                backgroundColor="rgba(6, 182, 212, 0.15)"
                alignItems="center"
                justifyContent="center"
                marginRight={14}
              >
                <CreditCard size={20} color={ACCENT} />
              </XStack>
              <YStack flex={1}>
                <Text fontSize={15} color={c.text} fontWeight="500" marginBottom={2}>
                  {t('profile.plan.entryTitle')}
                </Text>
                <Text fontSize={12} color={c.text2}>
                  {t('profile.plan.entrySub')}
                </Text>
              </YStack>
              <ChevronRight size={18} color={c.text3} />
            </XStack>
          </YStack>

          {/* Help Button */}
          <YStack
            backgroundColor={c.bgInner}
            borderWidth={1}
            borderColor={c.border}
            borderRadius={16}
            overflow="hidden"
          >
            <XStack
              padding={16}
              alignItems="center"
              pressStyle={{ backgroundColor: c.bgCardHover }}
              cursor="pointer"
            >
              <XStack
                width={40}
                height={40}
                borderRadius={10}
                backgroundColor="rgba(236, 72, 153, 0.15)"
                alignItems="center"
                justifyContent="center"
                marginRight={14}
              >
                <HelpCircle size={20} color={PINK} />
              </XStack>
              <YStack flex={1}>
                <Text fontSize={15} color={c.text} fontWeight="500" marginBottom={2}>
                  {t('profile.help')}
                </Text>
                <Text fontSize={12} color={c.text2}>
                  {t('profile.helpSub')}
                </Text>
              </YStack>
              <ChevronRight size={18} color={c.text3} />
            </XStack>
          </YStack>

          {/* Logout Button */}
          <Button
            height={52}
            backgroundColor="rgba(239, 68, 68, 0.1)"
            borderWidth={1}
            borderColor="rgba(239, 68, 68, 0.2)"
            borderRadius={12}
            pressStyle={{ backgroundColor: 'rgba(239, 68, 68, 0.15)' }}
            onPress={handleLogout}
          >
            <XStack alignItems="center" gap={8}>
              <LogOut size={18} color={RED} />
              <Text color={RED} fontSize={15} fontWeight="500">
                {t('profile.signOut')}
              </Text>
            </XStack>
          </Button>
        </YStack>

        {/* Version Footer */}
        <YStack padding={16} alignItems="center">
          <Text fontSize={11} color={c.text3}>
            {t('profile.madeWith')}
          </Text>
        </YStack>
      </ScrollView>
    </YStack>
  );
}
