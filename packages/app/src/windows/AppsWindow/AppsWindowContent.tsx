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

import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Image,
  ScrollView,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { getTerosClient } from '../../services/terosClientSingleton';
import { AppCard } from '../../components/AppCard';
import type { AppAuthInfo } from '../../components/apps';
import { useToast } from '../../components/Toast';
import { useClickModifiers } from '../../hooks/useClickModifiers';
import type { AppsWindowProps } from './definition';
import { useTilingStore } from '../../store/tilingStore';
import { AppSpinner, FullscreenLoader } from '../../components/ui';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { useColors } from '../../components/mca/primitives/useColors';
import {
  GOOGLE_FAKE_AUTH,
  GOOGLE_FAKE_INSTALLS,
  GOOGLE_PLACEHOLDER_CARDS,
} from '../CatalogWindow/googleSuite';

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

interface AppsWindowContentProps extends AppsWindowProps {
  windowId: string;
}

export function AppsWindowContent({ windowId, workspaceId, search: initialSearch }: AppsWindowContentProps) {
  const { t } = useTranslation();
  const [catalog, setCatalog] = useState<CatalogMca[]>([]);
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState(initialSearch || '');
  const [authStatuses, setAuthStatuses] = useState<Record<string, AppAuthInfo | null>>({});
  const [loadingAuthStatus, setLoadingAuthStatus] = useState<Record<string, boolean>>({});

  const { openWindow } = useTilingStore();
  const client = getTerosClient();
  const toast = useToast();
  const { shouldOpenInNewTab } = useClickModifiers();
  const activeWorkspaceId = workspaceId ?? useWorkspaceStore((s) => s.activeWorkspaceId);
  const c = useColors();

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
      const catalogResult = await client.app.listCatalog();
      // Fold in the Google Suite placeholder cards so their icon/category resolve
      // for the simulated installs below (they aren't in the backend catalog).
      setCatalog([
        ...(catalogResult.catalog as CatalogMca[]),
        ...(GOOGLE_PLACEHOLDER_CARDS as CatalogMca[]),
      ]);

      if (activeWorkspaceId) {
        const { apps: wsApps } = await client.workspace.listWorkspaceApps(activeWorkspaceId);
        const real = wsApps.map((a) => ({ appId: a.appId, mcaId: a.mcaId, name: a.name }));
        // Prototype: Docs (1 instance) + Sheets/Slides (2 each) are simulated
        // installs (see googleSuite.ts). Only the real apps hit the backend for
        // auth status; the fakes use a mocked "ready" status.
        setInstalledApps([...GOOGLE_FAKE_INSTALLS, ...real]);
        setAuthStatuses((prev) => ({
          ...prev,
          ...(GOOGLE_FAKE_AUTH as unknown as Record<string, AppAuthInfo>),
        }));
        loadAllAuthStatuses(real);
      }
    } catch (err: any) {
      console.error('Error loading apps:', err);
      toast.error(t('common.error'), t('apps.couldNotLoadApps'));
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
        mcaId={app.mcaId}
        category={mca?.category}
        authInfo={authInfo}
        loading={loading}
        onPress={(e?: any) => {
          openWindow('app', { appId: app.appId }, shouldOpenInNewTab(e));
        }}
      />
    );
  };

  return (
    <YStack flex={1} backgroundColor={c.bgPage}>
      {/* Header */}
      <YStack borderBottomWidth={1} borderBottomColor={c.border}>
        {/* Title and Search */}
        <XStack
          paddingHorizontal="$3"
          paddingVertical="$2"
          justifyContent="space-between"
          alignItems="center"
        >
          <Text fontSize={16} fontWeight="600" color={c.text}>
            {t('windows.myApps')}
          </Text>

          {/* Search */}
          <XStack
            backgroundColor={c.bgCard}
            borderRadius={6}
            paddingHorizontal="$2"
            paddingVertical="$1"
            alignItems="center"
            gap="$2"
            width={160}
            borderWidth={1}
            borderColor={c.borderStrong}
          >
            <Search size={12} color={c.text3} />
            <TextInput
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder={t('common.search')}
              placeholderTextColor={c.text3}
              style={{
                flex: 1,
                color: c.text,
                fontSize: 12,
              }}
            />
          </XStack>
        </XStack>
      </YStack>

      {isLoading ? (
        <FullscreenLoader variant="default" label={t('common.loading')} />
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, paddingBottom: 24 }}>
          {filteredInstalledApps.length > 0 ? (
            <XStack flexWrap="wrap" gap="$2">
              {filteredInstalledApps.map(renderInstalledAppCard)}
            </XStack>
          ) : (
            <YStack alignItems="center" padding="$6">
              <Package size={40} color={c.text3} />
              <Text color={c.text3} marginTop="$3" textAlign="center" fontSize={13}>
                {searchQuery ? t('apps.noAppsFound') : t('apps.noAppsInstalled')}
              </Text>
            </YStack>
          )}
        </ScrollView>
      )}
    </YStack>
  );
}
