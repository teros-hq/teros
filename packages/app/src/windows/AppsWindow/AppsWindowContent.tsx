/**
 * Apps Window Content
 *
 * Shows user's installed apps.
 */

import {
  Bot,
  Bug,
  Calendar,
  Check,
  CheckSquare,
  ChevronRight,
  Clock,
  Cloud,
  Database,
  Download,
  FileText,
  Folder,
  Globe,
  Mail,
  MessageSquare,
  Package,
  Plus,
  Search,
  Settings,
  Shield,
  Sparkles,
  Terminal,
  Wrench,
} from '@tamagui/lucide-icons';
import { useGlobalSearchParams, useRouter } from 'expo-router';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import {
  Image,
  ScrollView,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { getTerosClient } from '../../../app/_layout';
import { AppCard } from '../../components/AppCard';
import type { AppAuthInfo } from '../../components/apps';
import { useToast } from '../../components/Toast';
import { useClickModifiers } from '../../hooks/useClickModifiers';
import type { AppsWindowProps } from './definition';
import { AppSpinner, FullscreenLoader } from '../../components/ui';

interface CatalogMca {
  mcaId: string;
  name: string;
  description: string;
  icon?: string;
  color?: string;
  category: string;
  tools: string[];
  availability: {
    enabled: boolean;
    multi: boolean;
    system: boolean;
    hidden: boolean;
    role: 'user' | 'admin' | 'super';
  };
}

interface InstalledApp {
  appId: string;
  mcaId: string;
  name: string;
}

// Map icon names to Lucide components
const iconMap: Record<string, React.ComponentType<{ size?: number; color?: string }>> = {
  terminal: Terminal,
  folder: Folder,
  globe: Globe,
  package: Package,
  wrench: Wrench,
  message: MessageSquare,
  'message-square': MessageSquare,
  mail: Mail,
  calendar: Calendar,
  clock: Clock,
  database: Database,
  cloud: Cloud,
  settings: Settings,
  'check-square': CheckSquare,
  search: Search,
  bot: Bot,
  file: FileText,
  shield: Shield,
  bug: Bug,
  sparkles: Sparkles,
};

// Category display names
const categoryNames: Record<string, string> = {
  system: 'Sistema',
  productivity: 'Productividad',
  communication: 'Communication',
  integration: 'Integration',
  ai: 'Inteligencia Artificial',
  development: 'Desarrollo',
  data: 'Datos',
  media: 'Media',
  other: 'Otros',
};

interface AppsWindowContentProps extends AppsWindowProps {
  windowId: string;
}

export function AppsWindowContent({ windowId, search: initialSearch }: AppsWindowContentProps) {
  const [catalog, setCatalog] = useState<CatalogMca[]>([]);
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState(initialSearch || '');
  const [authStatuses, setAuthStatuses] = useState<Record<string, AppAuthInfo | null>>({});
  const [loadingAuthStatus, setLoadingAuthStatus] = useState<Record<string, boolean>>({});

  const router = useRouter();
  const globalParams = useGlobalSearchParams();
  const client = getTerosClient();
  const toast = useToast();
  const { shouldOpenInNewTab } = useClickModifiers();

  useEffect(() => {
    const tryLoadData = async () => {
      if (client.isConnected()) {
        loadData();
      } else {
        const onConnected = () => {
          client.off('connected', onConnected);
          loadData();
        };
        client.on('connected', onConnected);
        return () => {
          client.off('connected', onConnected);
        };
      }
    };
    tryLoadData();
  }, []);

  const loadAuthStatus = useCallback(
    async (appId: string) => {
      setLoadingAuthStatus((prev) => ({ ...prev, [appId]: true }));
      try {
        const authInfo = (await client.app.getAuthStatus(appId)).auth;
        setAuthStatuses((prev) => ({ ...prev, [appId]: authInfo as any }));
      } catch (err) {
        console.error(`Error loading auth status for ${appId}:`, err);
        setAuthStatuses((prev) => ({ ...prev, [appId]: null }));
      } finally {
        setLoadingAuthStatus((prev) => ({ ...prev, [appId]: false }));
      }
    },
    [client],
  );

  const loadAllAuthStatuses = useCallback(
    async (apps: InstalledApp[]) => {
      await Promise.all(apps.map((app) => loadAuthStatus(app.appId)));
    },
    [loadAuthStatus],
  );

  const loadData = async () => {
    setIsLoading(true);
    try {
      const [catalogResult, appsResult] = await Promise.all([client.app.listCatalog(), client.app.listApps()]);
      const catalogData = catalogResult.catalog as CatalogMca[];
      const appsData = appsResult.apps;
      setCatalog(catalogData);
      setInstalledApps(appsData);
      loadAllAuthStatuses(appsData);
    } catch (err: any) {
      console.error('Error loading apps:', err);
      toast.error('Error', 'No se pudo cargar las aplicaciones');
    } finally {
      setIsLoading(false);
    }
  };

  const getMcaForApp = (mcaId: string): CatalogMca | undefined => {
    return catalog.find((mca) => mca.mcaId === mcaId);
  };

  // Filter and sort installed apps based on search
  const filteredInstalledApps = installedApps
    .filter((app) => {
      if (!searchQuery) return true;
      const query = searchQuery.toLowerCase();
      const mca = getMcaForApp(app.mcaId);
      return (
        app.name.toLowerCase().includes(query) ||
        mca?.name.toLowerCase().includes(query) ||
        mca?.description.toLowerCase().includes(query)
      );
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // Render installed app card
  const renderInstalledAppCard = (app: InstalledApp) => {
    const mca = getMcaForApp(app.mcaId);
    const authInfo = authStatuses[app.appId];
    const loading = loadingAuthStatus[app.appId];

    return (
      <AppCard
        key={app.appId}
        appId={app.appId}
        name={app.name}
        icon={mca?.icon}
        color={mca?.color}
        category={mca?.category}
        authInfo={authInfo}
        loading={loading}
        onPress={(e) => {
          const url = `/app/${app.appId}`;
          if (shouldOpenInNewTab(e)) {
            router.push(`${url}?newTab=true`);
          } else {
            router.push(url);
          }
        }}
      />
    );
  };

  return (
    <YStack flex={1} backgroundColor="#09090B">
      {/* Header */}
      <YStack borderBottomWidth={1} borderBottomColor="rgba(39, 39, 42, 0.6)">
        {/* Title and Search */}
        <XStack
          paddingHorizontal="$3"
          paddingVertical="$2"
          justifyContent="space-between"
          alignItems="center"
        >
          <Text fontSize={16} fontWeight="600" color="#FAFAFA">
            Mis Apps
          </Text>

          {/* Search */}
          <XStack
            backgroundColor="rgba(39, 39, 42, 0.6)"
            borderRadius={6}
            paddingHorizontal="$2"
            paddingVertical="$1"
            alignItems="center"
            gap="$2"
            width={160}
            borderWidth={1}
            borderColor="rgba(63, 63, 70, 0.5)"
          >
            <Search size={12} color="#71717A" />
            <TextInput
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Buscar..."
              placeholderTextColor="#52525B"
              style={{
                flex: 1,
                color: '#FAFAFA',
                fontSize: 12,
              }}
            />
          </XStack>
        </XStack>
      </YStack>

      {isLoading ? (
        <FullscreenLoader variant="default" label="Cargando..." />
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, paddingBottom: 24 }}>
          {filteredInstalledApps.length > 0 ? (
            <XStack flexWrap="wrap" gap="$2">
              {filteredInstalledApps.map(renderInstalledAppCard)}
            </XStack>
          ) : (
            <YStack alignItems="center" padding="$6">
              <Package size={40} color="#27272A" />
              <Text color="#52525B" marginTop="$3" textAlign="center" fontSize={13}>
                {searchQuery ? 'No se encontraron apps' : 'No tienes apps instaladas'}
              </Text>
            </YStack>
          )}
        </ScrollView>
      )}
    </YStack>
  );
}
