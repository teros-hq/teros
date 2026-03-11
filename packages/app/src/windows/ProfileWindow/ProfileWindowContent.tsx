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
  Edit3,
  FileText,
  Gift,
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
import { Platform, ScrollView } from 'react-native';
import { Button, Input, Text, TextArea, XStack, YStack } from 'tamagui';
import { getTerosClient } from '../../../app/_layout';
import { useInvitations } from '../../hooks/useInvitations';
import { useAuthStore } from '../../store/authStore';
import { useTilingStore } from '../../store/tilingStore';
import type { ProfileWindowProps } from './definition';
import { AppSpinner, FullscreenLoader } from '../../components/ui';

interface Props extends ProfileWindowProps {
  windowId: string;
}

// Badge data type
interface Badge {
  id: string;
  title: string;
  description: string;
  reason: string;
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
    title: 'Founder',
    description: 'Founding member of Teros. Your vision helped build this from the beginning.',
    reason: 'Contribuidor original del proyecto',
    imageUrl: `${BACKEND_URL}/static/badges/kawaii-v1/05-lion-rockstar.webp`,
    gradientColors: ['#F59E0B', '#D97706'],
    borderColor: 'rgba(245, 158, 11, 0.3)',
    backgroundColors: ['rgba(245, 158, 11, 0.1)', 'rgba(217, 119, 6, 0.08)'],
  },
  {
    id: 'early-adopter',
    title: 'Early Adopter',
    description: 'Uno de los primeros en confiar en Teros. Gracias por ser parte del inicio.',
    reason: 'Miembro desde Diciembre 2024',
    imageUrl: `${BACKEND_URL}/static/badges/kawaii-v1/02-fox-programmer.webp`,
    gradientColors: ['#F97316', '#EA580C'],
    borderColor: 'rgba(249, 115, 22, 0.3)',
    backgroundColors: ['rgba(249, 115, 22, 0.1)', 'rgba(234, 88, 12, 0.08)'],
  },

  // === Usage Badges ===
  {
    id: 'first-steps',
    title: 'First Steps',
    description: 'You completed your first conversation. The beginning of a great journey.',
    reason: 'First conversation completed',
    imageUrl: `${BACKEND_URL}/static/badges/kawaii-v1/01-koala-barista.webp`,
    gradientColors: ['#06B6D4', '#0891B2'],
    borderColor: 'rgba(6, 182, 212, 0.3)',
    backgroundColors: ['rgba(6, 182, 212, 0.1)', 'rgba(8, 145, 178, 0.08)'],
  },
  {
    id: 'power-user',
    title: 'Power User',
    description: "Over 100 conversations. You've mastered the art of working with AI.",
    reason: '+100 conversaciones completadas',
    imageUrl: `${BACKEND_URL}/static/badges/kawaii-v1/04-octopus-dj.webp`,
    gradientColors: ['#EC4899', '#DB2777'],
    borderColor: 'rgba(236, 72, 153, 0.3)',
    backgroundColors: ['rgba(236, 72, 153, 0.1)', 'rgba(219, 39, 119, 0.08)'],
  },
  {
    id: 'super-user',
    title: 'Super User',
    description: 'Over 500 conversations. You are a productivity legend.',
    reason: '+500 conversaciones completadas',
    imageUrl: `${BACKEND_URL}/static/badges/kawaii-v1/07-shark-surfer.webp`,
    gradientColors: ['#3B82F6', '#2563EB'],
    borderColor: 'rgba(59, 130, 246, 0.3)',
    backgroundColors: ['rgba(59, 130, 246, 0.1)', 'rgba(37, 99, 235, 0.08)'],
  },

  // === Contribution Badges ===
  {
    id: 'bug-hunter',
    title: 'Bug Hunter',
    description: 'Encontraste y reportaste bugs importantes. Gracias por mejorar Teros.',
    reason: 'Reported critical bugs',
    imageUrl: `${BACKEND_URL}/static/badges/kawaii-v1/08-frog-scientist.webp`,
    gradientColors: ['#84CC16', '#65A30D'],
    borderColor: 'rgba(132, 204, 22, 0.3)',
    backgroundColors: ['rgba(132, 204, 22, 0.1)', 'rgba(101, 163, 13, 0.08)'],
  },
  {
    id: 'feature-requester',
    title: 'Visionary',
    description: 'Your ideas became features. Your vision improves the product.',
    reason: 'Suggested implemented features',
    imageUrl: `${BACKEND_URL}/static/badges/kawaii-v1/03-owl-wizard.webp`,
    gradientColors: ['#8B5CF6', '#7C3AED'],
    borderColor: 'rgba(139, 92, 246, 0.3)',
    backgroundColors: ['rgba(139, 92, 246, 0.1)', 'rgba(124, 58, 237, 0.08)'],
  },
  {
    id: 'beta-tester',
    title: 'Beta Tester',
    description: 'Probaste versiones experimentales. Tu feedback es invaluable.',
    reason: 'Tester de versiones beta',
    imageUrl: `${BACKEND_URL}/static/badges/kawaii-v1/06-panda-chef.webp`,
    gradientColors: ['#10B981', '#059669'],
    borderColor: 'rgba(16, 185, 129, 0.3)',
    backgroundColors: ['rgba(16, 185, 129, 0.1)', 'rgba(5, 150, 105, 0.08)'],
  },
];

// Stats data
const STATS = [
  { value: '0', label: 'Chats', icon: MessageSquare, color: 'cyan' },
  { value: '0', label: 'Agentes', icon: Users, color: 'purple' },
  { value: '0', label: 'Days', icon: Clock, color: 'amber' },
];

// Animated ring component for web
const AnimatedRing = () => {
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
        borderColor="#06B6D4"
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
          background: '#0a0a0a',
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
  return (
    <YStack gap="$2">
      <XStack alignItems="center" gap="$2">
        {icon}
        <Text fontSize={12} color="#71717A" textTransform="uppercase" letterSpacing={1}>
          {label}
        </Text>
      </XStack>
      {multiline ? (
        <TextArea
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          backgroundColor="rgba(255,255,255,0.03)"
          borderColor="rgba(255,255,255,0.1)"
          borderWidth={1}
          borderRadius={12}
          color="#FAFAFA"
          placeholderTextColor="#52525B"
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
          backgroundColor="rgba(255,255,255,0.03)"
          borderColor="rgba(255,255,255,0.1)"
          borderWidth={1}
          borderRadius={12}
          color="#FAFAFA"
          placeholderTextColor="#52525B"
          height={48}
          paddingHorizontal="$3"
          maxLength={maxLength}
          fontSize={14}
        />
      )}
      {maxLength && (
        <Text fontSize={11} color="#52525B" textAlign="right">
          {value.length}/{maxLength}
        </Text>
      )}
    </YStack>
  );
}

export function ProfileWindowContent({ windowId, onLogout }: Props) {
  const { user, logout, updateProfile } = useAuthStore();
  const client = getTerosClient();
  const { openWindow } = useTilingStore();
  const [activeIndex, setActiveIndex] = useState(0);
  const carouselRef = useRef<ScrollView>(null);

  // Invitations hook
  const { status: invitationStatus } = useInvitations(client);
  const availableInvitations = invitationStatus?.availableInvitations ?? 0;

  // View mode: 'view' or 'edit'
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state for edit mode
  const [displayName, setDisplayName] = useState(user?.name || '');
  const [description, setDescription] = useState(user?.description || '');
  const [locale, setLocale] = useState(user?.locale || '');
  const [timezone, setTimezone] = useState(user?.timezone || '');

  // Load profile on mount
  useEffect(() => {
    async function loadProfile() {
      try {
        const profile = await client.profile.getProfile();
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
        setIsLoading(false);
      } catch (err) {
        console.error('Failed to load profile:', err);
        setIsLoading(false);
      }
    }
    loadProfile();
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
      setTimeout(() => {
        setSaveSuccess(false);
        setMode('view');
      }, 1000);
    } catch (err) {
      console.error('Failed to update profile:', err);
      setError('Error al guardar el perfil');
      setIsSaving(false);
    }
  };

  if (!user) {
    return (
      <YStack flex={1} padding="$4" alignItems="center" justifyContent="center">
        <Text color="$gray10">No active session</Text>
      </YStack>
    );
  }

  if (isLoading) {
    return (
      <FullscreenLoader label="Cargando perfil..." />
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

  const handleScroll = (event: any) => {
    const scrollX = event.nativeEvent.contentOffset.x;
    const cardWidth = event.nativeEvent.layoutMeasurement.width - 48;
    const newIndex = Math.round(scrollX / cardWidth);
    if (newIndex !== activeIndex && newIndex >= 0 && newIndex < BADGES.length) {
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
        return '#06B6D4';
      case 'purple':
        return '#8B5CF6';
      case 'amber':
        return '#F59E0B';
      default:
        return '#71717A';
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
        return 'rgba(113, 113, 122, 0.15)';
    }
  };

  const memberSince = user.createdAt
    ? new Date(user.createdAt).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' })
    : 'Diciembre 2024';

  // ========================================
  // EDIT MODE
  // ========================================
  if (mode === 'edit') {
    return (
      <YStack flex={1} backgroundColor="#000000">
        <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
          {/* Header */}
          <XStack paddingHorizontal={24} paddingTop={20} paddingBottom={16} alignItems="center">
            <Button
              size="$3"
              circular
              backgroundColor="rgba(255,255,255,0.05)"
              borderWidth={0}
              onPress={() => setMode('view')}
              pressStyle={{ backgroundColor: 'rgba(255,255,255,0.1)' }}
            >
              <ArrowLeft size={20} color="#FAFAFA" />
            </Button>
            <Text flex={1} textAlign="center" fontSize={18} fontWeight="600" color="#FAFAFA">
              Editar Perfil
            </Text>
            <Button
              size="$3"
              circular
              backgroundColor={saveSuccess ? 'rgba(16, 185, 129, 0.2)' : 'rgba(6, 182, 212, 0.15)'}
              borderWidth={0}
              onPress={handleSave}
              disabled={isSaving}
              pressStyle={{ backgroundColor: 'rgba(6, 182, 212, 0.25)' }}
            >
              {isSaving ? (
                <AppSpinner size="sm" variant="brand" />
              ) : saveSuccess ? (
                <Check size={20} color="#10B981" />
              ) : (
                <Save size={20} color="#06B6D4" />
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
              <Text fontSize={13} color="#EF4444">
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
              backgroundColor="#1a1a2e"
              alignItems="center"
              justifyContent="center"
              borderWidth={2}
              borderColor="#06B6D4"
            >
              {user.avatarUrl ? (
                <img
                  src={user.avatarUrl}
                  alt={displayName || 'Avatar'}
                  style={{ width: '100%', height: '100%', borderRadius: 40, objectFit: 'cover' }}
                />
              ) : (
                <Text fontSize={28} fontWeight="600" color="#06B6D4">
                  {initials}
                </Text>
              )}
            </XStack>
          </YStack>

          {/* Form Fields */}
          <YStack paddingHorizontal={24} gap={20}>
            <EditableField
              label="Nombre"
              value={displayName}
              onChange={setDisplayName}
              icon={<User size={14} color="#71717A" />}
              placeholder="Tu nombre completo"
              maxLength={100}
            />

            <EditableField
              label="Description"
              value={description}
              onChange={setDescription}
              icon={<FileText size={14} color="#71717A" />}
              placeholder="Tell your agents about yourself: your work, interests, how you prefer to be helped..."
              multiline
              maxLength={1000}
            />

            <EditableField
              label="Idioma"
              value={locale}
              onChange={setLocale}
              icon={<Globe size={14} color="#71717A" />}
              placeholder="es-ES, en-US, etc."
              maxLength={10}
            />

            <EditableField
              label="Zona Horaria"
              value={timezone}
              onChange={setTimezone}
              icon={<Clock size={14} color="#71717A" />}
              placeholder="Europe/Madrid"
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
            <Text fontSize={13} color="#71717A" lineHeight={20}>
              💡 <Text color="#A1A1AA">The description</Text> helps your agents understand you better
              and give you more personalized responses.
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
    <YStack flex={1} backgroundColor="#000000">
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
              backgroundColor="#1a1a2e"
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
                <Text fontSize={42} fontWeight="600" color="#06B6D4" letterSpacing={2}>
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
              backgroundColor="#10B981"
              borderRadius={12}
              borderWidth={3}
              borderColor="#0a0a0a"
              zIndex={2}
            />
          </YStack>

          {/* Name & Email */}
          <Text fontSize={28} fontWeight="600" color="#FAFAFA" marginBottom={4}>
            {user.name || 'Usuario'}
          </Text>
          <Text fontSize={14} color="#71717A">
            {user.email}
          </Text>
          <Text fontSize={12} color="#52525B" marginTop={4}>
            Miembro desde {memberSince}
          </Text>
        </YStack>

        {/* Badge Carousel - Hidden for now */}
        {/* <YStack marginBottom={24}>
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
            {BADGES.map((badge) => (
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
                        alt={badge.title}
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
                    <Text fontSize={18} fontWeight="600" color="#FAFAFA" marginBottom={4}>
                      {badge.title}
                    </Text>
                    <Text fontSize={13} color="#A1A1AA" lineHeight={20}>
                      {badge.description}
                    </Text>
                  </YStack>
                </XStack>
                
                <YStack 
                  marginTop={16} 
                  paddingTop={14} 
                  borderTopWidth={1} 
                  borderTopColor="rgba(255,255,255,0.08)"
                >
                  <Text 
                    fontSize={11} 
                    color="#52525B" 
                    textTransform="uppercase" 
                    letterSpacing={1}
                  >
                    {badge.reason}
                  </Text>
                </YStack>
              </LinearGradient>
            ))}
          </ScrollView>
          
          <XStack justifyContent="center" gap={8} marginTop={16}>
            {BADGES.map((_, index) => (
              <XStack
                key={index}
                width={activeIndex === index ? 24 : 8}
                height={8}
                borderRadius={4}
                backgroundColor={activeIndex === index ? '#06B6D4' : 'rgba(255,255,255,0.2)'}
                pressStyle={{ opacity: 0.8 }}
                onPress={() => scrollToIndex(index)}
                cursor="pointer"
              />
            ))}
          </XStack>
        </YStack> */}

        {/* Stats Grid */}
        <YStack paddingHorizontal={24} marginBottom={24}>
          <XStack gap={12}>
            {STATS.map((stat) => (
              <YStack
                key={stat.label}
                flex={1}
                backgroundColor="rgba(255,255,255,0.03)"
                borderWidth={1}
                borderColor="rgba(255,255,255,0.06)"
                borderRadius={16}
                padding={16}
                alignItems="center"
                pressStyle={{ backgroundColor: 'rgba(255,255,255,0.05)' }}
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
                <Text fontSize={22} fontWeight="700" color="#FAFAFA" marginBottom={2}>
                  {stat.value}
                </Text>
                <Text fontSize={10} color="#71717A" textTransform="uppercase" letterSpacing={0.5}>
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
            backgroundColor="rgba(255,255,255,0.02)"
            borderWidth={1}
            borderColor="rgba(255,255,255,0.05)"
            borderRadius={16}
            overflow="hidden"
          >
            <XStack
              padding={16}
              alignItems="center"
              pressStyle={{ backgroundColor: 'rgba(255,255,255,0.03)' }}
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
                <Edit3 size={20} color="#06B6D4" />
              </XStack>
              <YStack flex={1}>
                <Text fontSize={15} color="#FAFAFA" fontWeight="500" marginBottom={2}>
                  Editar Perfil
                </Text>
                <Text fontSize={12} color="#71717A">
                  Name, description, preferences
                </Text>
              </YStack>
              <ChevronRight size={18} color="#3F3F46" />
            </XStack>
          </YStack>

          {/* Invitations Button */}
          <YStack
            backgroundColor="rgba(255,255,255,0.02)"
            borderWidth={1}
            borderColor="rgba(255,255,255,0.05)"
            borderRadius={16}
            overflow="hidden"
          >
            <XStack
              padding={16}
              alignItems="center"
              pressStyle={{ backgroundColor: 'rgba(255,255,255,0.03)' }}
              cursor="pointer"
              onPress={() => openWindow('invitations', {}, false, windowId)}
            >
              <XStack
                width={40}
                height={40}
                borderRadius={10}
                backgroundColor="rgba(139, 92, 246, 0.15)"
                alignItems="center"
                justifyContent="center"
                marginRight={14}
                position="relative"
              >
                <Gift size={20} color="#8B5CF6" />
                {availableInvitations > 0 && (
                  <XStack
                    position="absolute"
                    top={-4}
                    right={-4}
                    minWidth={18}
                    height={18}
                    borderRadius={9}
                    backgroundColor="#8B5CF6"
                    alignItems="center"
                    justifyContent="center"
                    paddingHorizontal={4}
                  >
                    <Text fontSize={10} fontWeight="700" color="#FFFFFF">
                      {availableInvitations}
                    </Text>
                  </XStack>
                )}
              </XStack>
              <YStack flex={1}>
                <Text fontSize={15} color="#FAFAFA" fontWeight="500" marginBottom={2}>
                  Invitaciones
                </Text>
                <Text fontSize={12} color="#71717A">
                  {availableInvitations > 0
                    ? `You have ${availableInvitations} invitation${availableInvitations > 1 ? 's' : ''} available`
                    : 'Ver estado de invitaciones'}
                </Text>
              </YStack>
              <ChevronRight size={18} color="#3F3F46" />
            </XStack>
          </YStack>

          {/* Help Button */}
          <YStack
            backgroundColor="rgba(255,255,255,0.02)"
            borderWidth={1}
            borderColor="rgba(255,255,255,0.05)"
            borderRadius={16}
            overflow="hidden"
          >
            <XStack
              padding={16}
              alignItems="center"
              pressStyle={{ backgroundColor: 'rgba(255,255,255,0.03)' }}
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
                <HelpCircle size={20} color="#EC4899" />
              </XStack>
              <YStack flex={1}>
                <Text fontSize={15} color="#FAFAFA" fontWeight="500" marginBottom={2}>
                  Ayuda
                </Text>
                <Text fontSize={12} color="#71717A">
                  FAQ, contact, documentation
                </Text>
              </YStack>
              <ChevronRight size={18} color="#3F3F46" />
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
              <LogOut size={18} color="#EF4444" />
              <Text color="#EF4444" fontSize={15} fontWeight="500">
                Sign Out
              </Text>
            </XStack>
          </Button>
        </YStack>

        {/* Version Footer */}
        <YStack padding={16} alignItems="center">
          <Text fontSize={11} color="#3F3F46">
            Teros · Made with ♥
          </Text>
        </YStack>
      </ScrollView>
    </YStack>
  );
}
