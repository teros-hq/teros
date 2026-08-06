/**
 * Project Window Content
 *
 * Shows project details, task stats, active tasks, and an editable context field.
 *
 * Migrated to the Design System:
 * - Uses `useColors()` for theme-adaptive surface/border/text tokens.
 * - Uses `semanticColors` for status accents (indigo, green, red).
 * - Uses `isDark` to switch dark-only rgba values to light equivalents.
 * - Uses Tamagui `Text`, `XStack`, `YStack` for layout and typography.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, TextInput, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text, XStack, YStack } from 'tamagui';
import { getTerosClient } from '../../services/terosClientSingleton';
import { useTilingStore } from '../../store/tilingStore';
import { useColors } from '../../components/mca/primitives/useColors';
import { colors as semanticColors, surface } from '../../components/mca/primitives/colors';
import { AppSpinner } from '../../components/ui/AppSpinner';


interface Props {
  projectId: string;
  projectName?: string;
  workspaceId?: string;
}

interface Project {
  projectId: string;
  name: string;
  description?: string;
  context?: string;
  boardId: string;
}

interface Task {
  taskId: string;
  title: string;
  status: string;
  assignedAgentId?: string;
}

export function ProjectWindowContent({ projectId, projectName, workspaceId }: Props) {
  const { t } = useTranslation();
  const client = getTerosClient();
  const { openWindow } = useTilingStore();
  const c = useColors();
  const isDark = c.bgPage === surface.dark.bgPage;

  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [context, setContext] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingContext, setSavingContext] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [projRes, tasksRes] = await Promise.all([
          client.project.get(projectId),
          client.board.listTasks(projectId),
        ]);
        if (cancelled) return;
        setProject(projRes.project);
        setContext(projRes.project?.context ?? '');
        setTasks((tasksRes.tasks ?? []) as any);
      } catch (e) {
        console.error('[ProjectWindow] load error', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const handleContextSave = useCallback(
    async (next: string) => {
      setSavingContext(true);
      try {
        await client.project.update(projectId, { context: next });
        setProject((prev) => (prev ? { ...prev, context: next } : null));
      } catch (e) {
        console.error('[ProjectWindow] save context error', e);
      } finally {
        setSavingContext(false);
      }
    },
    [projectId, client],
  );

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleContextChange = useCallback(
    (next: string) => {
      setContext(next);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void handleContextSave(next);
      }, 800);
    },
    [handleContextSave],
  );
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  // Stats
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === 'done').length;
  const inProgress = tasks.filter((t) => t.status === 'working' || t.status === 'assigned').length;
  const blocked = tasks.filter((t) => t.status === 'blocked').length;
  const activeTasks = tasks.filter((t) => t.status === 'working' || t.status === 'assigned');

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <AppSpinner size="md" variant="brand" />
      </View>
    );
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bgPage }} contentContainerStyle={{ padding: 20, gap: 20 }}>
      {/* Header */}
      <XStack alignItems="flex-start" justifyContent="space-between" gap={12}>
        <YStack flex={1}>
          <Text fontSize={20} fontWeight="600" color={c.text}>
            {project?.name ?? projectName ?? t('project.fallbackTitle')}
          </Text>
          {project?.description ? (
            <Text fontSize={13} color={c.text3} marginTop={4}>
              {project.description}
            </Text>
          ) : null}
        </YStack>
        <TouchableOpacity
          style={{
            backgroundColor: isDark ? 'rgba(39,39,42,0.6)' : c.bgInner,
            borderRadius: 8,
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderWidth: 1,
            borderColor: c.border,
          }}
          onPress={() =>
            openWindow('board', { projectId, projectName: project?.name ?? projectName })
          }
        >
          <Text color={c.text2} fontSize={13}>
            {t('project.boardButton')}
          </Text>
        </TouchableOpacity>
      </XStack>

      {/* Stats */}
      <XStack gap={12}>
        {[
          { label: t('project.total'), value: total, color: c.text2 },
          { label: t('project.done'), value: done, color: semanticColors.green },
          { label: t('project.inProgress'), value: inProgress, color: semanticColors.indigo },
          { label: t('project.blocked'), value: blocked, color: semanticColors.red },
        ].map((stat) => (
          <View
            key={stat.label}
            style={{
              flex: 1,
              backgroundColor: c.bgCard,
              borderRadius: 8,
              padding: 12,
              alignItems: 'center',
              borderWidth: 1,
              borderColor: c.border,
            }}
          >
            <Text fontSize={24} fontWeight="700" color={stat.color}>
              {stat.value}
            </Text>
            <Text fontSize={11} color={c.text3} marginTop={2}>
              {stat.label}
            </Text>
          </View>
        ))}
      </XStack>

      {/* Active tasks */}
      {activeTasks.length > 0 && (
        <YStack gap={8}>
          <Text fontSize={13} fontWeight="600" color={c.text2}>
            {t('project.activeTasks')}
          </Text>
          {activeTasks.map((task) => (
            <XStack key={task.taskId} alignItems="center" gap={8} paddingVertical={4}>
              <View
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: task.status === 'working' ? semanticColors.indigo : c.text2,
                }}
              />
              <Text flex={1} fontSize={13} color={c.text} numberOfLines={1}>
                {task.title}
              </Text>
            </XStack>
          ))}
        </YStack>
      )}

      {/* Context */}
      <YStack gap={8}>
        <Text fontSize={13} fontWeight="600" color={c.text2}>
          {t('project.contextTitle')}
        </Text>
        <TextInput
          style={{
            backgroundColor: isDark ? 'rgba(39,39,42,0.6)' : c.bgInner,
            borderWidth: 1,
            borderColor: c.border,
            borderRadius: 8,
            padding: 12,
            color: c.text,
            fontSize: 13,
            minHeight: 120,
            textAlignVertical: 'top',
          }}
          value={context}
          onChangeText={handleContextChange}
          multiline
          placeholder={t('project.contextPlaceholder')}
          placeholderTextColor={c.text3}
        />
      </YStack>
    </ScrollView>
  );
}
