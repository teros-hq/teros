/**
 * Skills Window Content
 *
 * CRUD UI for workspace-level skills (reusable instruction blocks for agents).
 * Uses the same transport.request pattern as AgentWindowContent for skill API calls.
 */

import { BookOpen, Plus, Pencil, Trash2, Check, X, ChevronDown, ChevronUp } from '@tamagui/lucide-icons';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, TextInput, TouchableOpacity, View } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { useTranslation } from 'react-i18next';
import { getTerosClient } from '../../services/terosClientSingleton';
import { useToast } from '../../components/Toast';
import { useWorkspaceStore } from '../../store/workspaceStore';
import { FullscreenLoader } from '../../components/ui';
import { ContextEditor } from '../../components/ContextEditor';
import type { SkillsWindowProps } from './definition';
import { useColors } from '../../components/mca/primitives/useColors';
import { colors as semanticColors, surface } from '../../components/mca/primitives/colors';

interface Skill {
  skillId: string;
  name: string;
  description?: string;
  content: string;
  category?: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

interface SkillsWindowContentProps extends SkillsWindowProps {
  windowId: string;
}

interface SkillFormState {
  name: string;
  description: string;
  content: string;
}

const EMPTY_FORM: SkillFormState = { name: '', description: '', content: '' };

export function SkillsWindowContent({ windowId, workspaceId: propWorkspaceId }: SkillsWindowContentProps) {
  const { t } = useTranslation();
  const c = useColors();
  const isDark = c.bgPage === surface.dark.bgPage;

  const [skills, setSkills] = useState<Skill[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState<SkillFormState>(EMPTY_FORM);
  const [isCreating, setIsCreating] = useState(false);

  // Edit state — one skill at a time
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<SkillFormState>(EMPTY_FORM);
  const [isSaving, setIsSaving] = useState(false);

  // Delete confirmation
  const [deletingSkillId, setDeletingSkillId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Expanded content view
  const [expandedSkillId, setExpandedSkillId] = useState<string | null>(null);

  const client = getTerosClient();
  const toast = useToast();
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const workspaceId = propWorkspaceId ?? activeWorkspaceId ?? '';

  // Theme-adaptive input style — shared by all TextInput fields
  const inputStyle = {
    backgroundColor: isDark ? 'rgba(39,39,42,0.6)' : c.bgInner,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: c.borderStrong,
    color: c.text,
    fontSize: 13,
    padding: 8,
  } as const;

  const inputStyleMono = {
    ...inputStyle,
    fontSize: 12,
    fontFamily: '$mono' as const,
    minHeight: 120,
    textAlignVertical: 'top' as const,
  };

  const loadSkills = useCallback(async () => {
    if (!workspaceId) return;
    setIsLoading(true);
    try {
      const result = await client.skillRequest('skill.list', { workspaceId });
      setSkills((result as any)?.skills ?? []);
    } catch (err: any) {
      console.error('[SkillsWindow] Error loading skills:', err);
      toast.error(t('skills.error'), t('skills.loadError'));
    } finally {
      setIsLoading(false);
    }
  }, [workspaceId, client]);

  useEffect(() => {
    const tryLoad = async () => {
      if (client.isConnected()) {
        loadSkills();
      } else {
        const onConnected = () => {
          client.off('connected', onConnected);
          loadSkills();
        };
        client.on('connected', onConnected);
        return () => client.off('connected', onConnected);
      }
    };
    tryLoad();
  }, [loadSkills]);

  // ── CREATE ──────────────────────────────────────────────────────────────────
  const handleCreate = async () => {
    if (!createForm.name.trim()) {
      toast.error(t('skills.error'), t('skills.nameRequired'));
      return;
    }
    if (!createForm.content.trim()) {
      toast.error(t('skills.error'), t('skills.contentRequired'));
      return;
    }
    setIsCreating(true);
    try {
      const result = await client.skillRequest('skill.create', {
        workspaceId,
        name: createForm.name.trim(),
        description: createForm.description.trim() || undefined,
        content: createForm.content.trim(),
      });
      const newSkill = (result as any)?.skill as Skill;
      setSkills((prev) => [...prev, newSkill]);
      setCreateForm(EMPTY_FORM);
      setShowCreate(false);
      toast.success(t('skills.created'), t('skills.createdMessage', { name: newSkill.name }));
    } catch (err: any) {
      console.error('[SkillsWindow] Error creating skill:', err);
      toast.error(t('skills.error'), t('skills.createError'));
    } finally {
      setIsCreating(false);
    }
  };

  // ── EDIT ────────────────────────────────────────────────────────────────────
  const startEdit = (skill: Skill) => {
    setEditingSkillId(skill.skillId);
    setEditForm({
      name: skill.name,
      description: skill.description ?? '',
      content: skill.content,
    });
    setDeletingSkillId(null);
  };

  const cancelEdit = () => {
    setEditingSkillId(null);
    setEditForm(EMPTY_FORM);
  };

  const handleSave = async (skillId: string) => {
    if (!editForm.name.trim()) {
      toast.error(t('skills.error'), t('skills.nameRequired'));
      return;
    }
    if (!editForm.content.trim()) {
      toast.error(t('skills.error'), t('skills.contentRequired'));
      return;
    }
    setIsSaving(true);
    try {
      const result = await client.skillRequest('skill.update', {
        skillId,
        name: editForm.name.trim(),
        description: editForm.description.trim() || undefined,
        content: editForm.content.trim(),
      });
      const updated = (result as any)?.skill as Skill;
      setSkills((prev) => prev.map((s) => (s.skillId === skillId ? updated : s)));
      setEditingSkillId(null);
      toast.success(t('skills.saved'), t('skills.updatedMessage', { name: updated.name }));
    } catch (err: any) {
      console.error('[SkillsWindow] Error updating skill:', err);
      toast.error(t('skills.error'), t('skills.saveError'));
    } finally {
      setIsSaving(false);
    }
  };

  // ── DELETE ───────────────────────────────────────────────────────────────────
  const handleDelete = async (skillId: string) => {
    setIsDeleting(true);
    try {
      await client.skillRequest('skill.delete', { skillId });
      setSkills((prev) => prev.filter((s) => s.skillId !== skillId));
      setDeletingSkillId(null);
      toast.success(t('skills.deleted'), t('skills.deletedMessage'));
    } catch (err: any) {
      console.error('[SkillsWindow] Error deleting skill:', err);
      toast.error(t('skills.error'), t('skills.deleteError'));
    } finally {
      setIsDeleting(false);
    }
  };

  // ── RENDER ───────────────────────────────────────────────────────────────────
  const renderSkillRow = (skill: Skill) => {
    const isEditing = editingSkillId === skill.skillId;
    const isConfirmingDelete = deletingSkillId === skill.skillId;
    const isExpanded = expandedSkillId === skill.skillId;

    if (isEditing) {
      return (
        <YStack
          key={skill.skillId}
          backgroundColor={c.bgCard}
          borderRadius={8}
          borderWidth={1}
          borderColor={semanticColors.indigo}
          padding="$3"
          gap="$2"
        >
          {/* Name */}
          <Text fontSize={11} color={c.text3} fontWeight="500">{t('skills.labelName')}</Text>
          <TextInput
            value={editForm.name}
            onChangeText={(v) => setEditForm((f) => ({ ...f, name: v }))}
            placeholder={t('skills.namePlaceholder')}
            placeholderTextColor={c.text3}
            style={inputStyle}
          />

          {/* Description */}
          <Text fontSize={11} color={c.text3} fontWeight="500">{t('skills.labelDescription')}</Text>
          <TextInput
            value={editForm.description}
            onChangeText={(v) => setEditForm((f) => ({ ...f, description: v }))}
            placeholder={t('skills.descriptionPlaceholder')}
            placeholderTextColor={c.text3}
            style={inputStyle}
          />

          {/* Content */}
          <Text fontSize={11} color={c.text3} fontWeight="500">{t('skills.labelContent')}</Text>
          <TextInput
            value={editForm.content}
            onChangeText={(v) => setEditForm((f) => ({ ...f, content: v }))}
            placeholder={t('skills.contentPlaceholder')}
            placeholderTextColor={c.text3}
            multiline
            numberOfLines={6}
            style={inputStyleMono}
          />

          {/* Actions */}
          <XStack gap="$2" justifyContent="flex-end" marginTop="$1">
            <TouchableOpacity
              onPress={cancelEdit}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 6,
                backgroundColor: isDark ? 'rgba(39,39,42,0.6)' : c.bgInner,
              }}
            >
              <X size={13} color={c.text2} />
              <Text fontSize={12} color={c.text2}>{t('common.cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => handleSave(skill.skillId)}
              disabled={isSaving}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 6,
                backgroundColor: semanticColors.indigo,
                opacity: isSaving ? 0.6 : 1,
              }}
            >
              <Check size={13} color="#fff" />
              <Text fontSize={12} color="#fff">{isSaving ? t('common.saving') : t('common.save')}</Text>
            </TouchableOpacity>
          </XStack>
        </YStack>
      );
    }

    return (
      <YStack
        key={skill.skillId}
        backgroundColor={c.bgCard}
        borderRadius={8}
        borderWidth={1}
        borderColor={isConfirmingDelete ? semanticColors.red : c.border}
        padding="$3"
        gap="$2"
      >
        {/* Header row */}
        <XStack alignItems="center" justifyContent="space-between">
          <XStack alignItems="center" gap="$2" flex={1}>
            <BookOpen size={14} color={semanticColors.indigo} />
            <Text fontSize={14} fontWeight="600" color={c.text} flex={1} numberOfLines={1}>
              {skill.name}
            </Text>
          </XStack>

          {/* Action buttons */}
          {!isConfirmingDelete && (
            <XStack gap="$2" alignItems="center">
              <TouchableOpacity
                onPress={() => setExpandedSkillId(isExpanded ? null : skill.skillId)}
                style={{ padding: 4 }}
              >
                {isExpanded
                  ? <ChevronUp size={14} color={c.text3} />
                  : <ChevronDown size={14} color={c.text3} />}
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => startEdit(skill)}
                style={{
                  padding: 4,
                  borderRadius: 4,
                  backgroundColor: isDark ? 'rgba(39,39,42,0.6)' : c.bgInner,
                }}
              >
                <Pencil size={13} color={c.text2} />
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => { setDeletingSkillId(skill.skillId); setEditingSkillId(null); }}
                style={{
                  padding: 4,
                  borderRadius: 4,
                  backgroundColor: isDark ? 'rgba(39,39,42,0.6)' : c.bgInner,
                }}
              >
                <Trash2 size={13} color={semanticColors.red} />
              </TouchableOpacity>
            </XStack>
          )}
        </XStack>

        {/* Description */}
        {skill.description && (
          <Text fontSize={12} color={c.text3} numberOfLines={isExpanded ? undefined : 2}>
            {skill.description}
          </Text>
        )}

        {/* Expanded content */}
        {isExpanded && (
          <YStack
            backgroundColor={c.bgInner}
            borderRadius={6}
            padding="$2"
            borderWidth={1}
            borderColor={c.border}
          >
            <Text fontSize={11} color={c.text3} fontWeight="500" marginBottom="$1">{t('skills.contentLabel')}</Text>
            <Text fontSize={12} color={c.text2} fontFamily="$mono" style={{ lineHeight: 18 }}>
              {skill.content}
            </Text>
          </YStack>
        )}

        {/* Delete confirmation */}
        {isConfirmingDelete && (
          <YStack gap="$2" marginTop="$1">
            <Text fontSize={12} color={c.badges.err.text}>
              {t('skills.deleteConfirm', { name: skill.name })}
            </Text>
            <XStack gap="$2" justifyContent="flex-end">
              <TouchableOpacity
                onPress={() => setDeletingSkillId(null)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 4,
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  borderRadius: 6,
                  backgroundColor: isDark ? 'rgba(39,39,42,0.6)' : c.bgInner,
                }}
              >
                <X size={13} color={c.text2} />
                <Text fontSize={12} color={c.text2}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => handleDelete(skill.skillId)}
                disabled={isDeleting}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 4,
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  borderRadius: 6,
                  backgroundColor: semanticColors.red,
                  opacity: isDeleting ? 0.6 : 1,
                }}
              >
                <Trash2 size={13} color="#fff" />
                <Text fontSize={12} color="#fff">{isDeleting ? t('skills.deleting') : t('common.delete')}</Text>
              </TouchableOpacity>
            </XStack>
          </YStack>
        )}
      </YStack>
    );
  };

  return (
    <YStack flex={1} backgroundColor={c.bgPage}>
      {/* Header */}
      <XStack
        paddingHorizontal="$3"
        paddingVertical="$2"
        borderBottomWidth={1}
        borderBottomColor={isDark ? 'rgba(39,39,42,0.6)' : c.bgInner}
        justifyContent="space-between"
        alignItems="center"
      >
        <Text fontSize={16} fontWeight="600" color={c.text}>
          {t('skills.title')}
        </Text>
        <TouchableOpacity
          onPress={() => { setShowCreate(true); setEditingSkillId(null); setDeletingSkillId(null); }}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderRadius: 6,
            backgroundColor: semanticColors.indigo,
          }}
        >
          <Plus size={13} color="#fff" />
          <Text fontSize={12} color="#fff" fontWeight="500">{t('skills.newSkill')}</Text>
        </TouchableOpacity>
      </XStack>

      {isLoading ? (
        <FullscreenLoader variant="default" label={t('skills.loadingSkills')} />
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12, paddingBottom: 24, gap: 8 }}>
          {/* Create form */}
          {showCreate && (
            <YStack
              backgroundColor={c.bgCard}
              borderRadius={8}
              borderWidth={1}
              borderColor={semanticColors.indigo}
              padding="$3"
              gap="$2"
              marginBottom={8}
            >
              <Text fontSize={13} fontWeight="600" color={semanticColors.indigo} marginBottom="$1">
                {t('skills.newSkill')}
              </Text>

              <Text fontSize={11} color={c.text3} fontWeight="500">{t('skills.labelName')}</Text>
              <TextInput
                value={createForm.name}
                onChangeText={(v) => setCreateForm((f) => ({ ...f, name: v }))}
                placeholder={t('skills.namePlaceholder')}
                placeholderTextColor={c.text3}
                autoFocus
                style={inputStyle}
              />

              <Text fontSize={11} color={c.text3} fontWeight="500">{t('skills.labelDescription')}</Text>
              <TextInput
                value={createForm.description}
                onChangeText={(v) => setCreateForm((f) => ({ ...f, description: v }))}
                placeholder={t('skills.descriptionPlaceholder')}
                placeholderTextColor={c.text3}
                style={inputStyle}
              />

              <Text fontSize={11} color={c.text3} fontWeight="500">{t('skills.labelContent')}</Text>
              <TextInput
                value={createForm.content}
                onChangeText={(v) => setCreateForm((f) => ({ ...f, content: v }))}
                placeholder={t('skills.contentPlaceholder')}
                placeholderTextColor={c.text3}
                multiline
                numberOfLines={6}
                style={inputStyleMono}
              />

              <XStack gap="$2" justifyContent="flex-end" marginTop="$1">
                <TouchableOpacity
                  onPress={() => { setShowCreate(false); setCreateForm(EMPTY_FORM); }}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 4,
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderRadius: 6,
                    backgroundColor: isDark ? 'rgba(39,39,42,0.6)' : c.bgInner,
                  }}
                >
                  <X size={13} color={c.text2} />
                  <Text fontSize={12} color={c.text2}>{t('common.cancel')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={handleCreate}
                  disabled={isCreating}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 4,
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderRadius: 6,
                    backgroundColor: semanticColors.indigo,
                    opacity: isCreating ? 0.6 : 1,
                  }}
                >
                  <Check size={13} color="#fff" />
                  <Text fontSize={12} color="#fff">{isCreating ? t('skills.creating') : t('common.create')}</Text>
                </TouchableOpacity>
              </XStack>
            </YStack>
          )}

          {/* Skills list */}
          {skills.length === 0 && !showCreate ? (
            <YStack alignItems="center" padding="$8">
              <BookOpen size={40} color={c.border} />
              <Text color={c.text3} marginTop="$3" textAlign="center" fontSize={13}>
                {t('skills.noSkills')}
              </Text>
              <Text color={c.text3} marginTop="$1" textAlign="center" fontSize={12} opacity={0.7}>
                {t('skills.noSkillsHint')}
              </Text>
            </YStack>
          ) : (
            <YStack gap={8}>
              {skills.map(renderSkillRow)}
            </YStack>
          )}
        </ScrollView>
      )}
    </YStack>
  );
}
