/**
 * Agent Cores Window Content
 *
 * View and manage agent cores (base personalities/engines):
 * - List all agent cores with their configurations
 * - Edit model assignments and overrides
 * - Edit system prompts
 */

import {
  Check,
  ChevronDown,
  ChevronUp,
  Cpu,
  Hash,
  Pencil,
  Save,
  Sparkles,
  ThermometerSun,
  User,
  Wrench,
  X,
} from '@tamagui/lucide-icons';
import type React from 'react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { FlatList, Platform, StyleSheet, TouchableOpacity, View } from 'react-native';
import {
  Avatar,
  Button,
  Input,
  ScrollView,
  Separator,
  Sheet,
  Text,
  TextArea,
  XStack,
  YStack,
} from 'tamagui';
import { getTerosClient } from '../../../app/_layout';
import { AppSpinner, FullscreenLoader } from '../../components/ui';

// Portal component for web
function Portal({ children }: { children: React.ReactNode }) {
  if (Platform.OS !== 'web') {
    return <>{children}</>;
  }
  return createPortal(children, document.body);
}

interface AgentCore {
  coreId: string;
  name: string;
  fullName: string;
  version: string;
  systemPrompt: string;
  personality: string[];
  capabilities: string[];
  avatarUrl: string;
  modelId: string;
  modelOverrides?: {
    temperature?: number;
    maxTokens?: number;
  };
  status: 'active' | 'inactive';
}

interface Model {
  modelId: string;
  name: string;
  provider: string;
  status: string;
}

const STATUS_COLORS: Record<string, string> = {
  active: '#22C55E',
  inactive: '#71717A',
};

function Badge({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <XStack
      paddingHorizontal="$2"
      paddingVertical="$1"
      backgroundColor={`${color}15`}
      borderRadius="$2"
      borderWidth={1}
      borderColor={`${color}30`}
    >
      <Text fontSize="$1" color={color}>
        {children}
      </Text>
    </XStack>
  );
}

interface EditModalProps {
  core: AgentCore;
  models: Model[];
  open: boolean;
  onClose: () => void;
  onSave: (updates: Partial<AgentCore>) => Promise<void>;
  onOpenModelPicker: () => void;
  selectedModelId: string;
}

function EditModal({
  core,
  models,
  open,
  onClose,
  onSave,
  onOpenModelPicker,
  selectedModelId,
}: EditModalProps) {
  const [modelId, setModelId] = useState(core.modelId);
  const [temperature, setTemperature] = useState(
    core.modelOverrides?.temperature?.toString() || '',
  );
  const [maxTokens, setMaxTokens] = useState(core.modelOverrides?.maxTokens?.toString() || '');
  const [systemPrompt, setSystemPrompt] = useState(core.systemPrompt);
  const [saving, setSaving] = useState(false);

  // Reset form when core changes
  useEffect(() => {
    setModelId(core.modelId);
    setTemperature(core.modelOverrides?.temperature?.toString() || '');
    setMaxTokens(core.modelOverrides?.maxTokens?.toString() || '');
    setSystemPrompt(core.systemPrompt);
  }, [core]);

  // Update modelId when selectedModelId changes (from external picker)
  useEffect(() => {
    if (selectedModelId && selectedModelId !== modelId) {
      setModelId(selectedModelId);
    }
  }, [selectedModelId]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const updates: Partial<AgentCore> = {
        modelId,
        systemPrompt,
        modelOverrides: {
          ...(temperature ? { temperature: parseFloat(temperature) } : {}),
          ...(maxTokens ? { maxTokens: parseInt(maxTokens, 10) } : {}),
        },
      };

      // Remove empty modelOverrides
      if (Object.keys(updates.modelOverrides || {}).length === 0) {
        delete updates.modelOverrides;
      }

      await onSave(updates);
      onClose();
    } catch (err) {
      console.error('Failed to save:', err);
    } finally {
      setSaving(false);
    }
  };

  const activeModels = models.filter((m) => m.status === 'active');
  const selectedModel = activeModels.find((m) => m.modelId === modelId);

  return (
    <Sheet
      modal
      open={open}
      onOpenChange={(isOpen: boolean) => !isOpen && onClose()}
      snapPoints={[90]}
      dismissOnSnapToBottom
      zIndex={100000}
    >
      <Sheet.Overlay backgroundColor="rgba(0,0,0,0.5)" />
      <Sheet.Frame backgroundColor="$background" padding="$4">
        <Sheet.Handle backgroundColor="$gray8" />

        <YStack gap="$4" marginTop="$2">
          {/* Header */}
          <XStack justifyContent="space-between" alignItems="center">
            <XStack alignItems="center" gap="$2">
              <Pencil size={20} color="#06B6D4" />
              <Text fontSize="$5" fontWeight="600" color="$color">
                Edit {core.fullName}
              </Text>
            </XStack>
            <Button size="$2" circular chromeless icon={<X size={18} />} onPress={onClose} />
          </XStack>

          <ScrollView flex={1}>
            <YStack gap="$4">
              {/* Model Selection - Custom Picker */}
              <YStack gap="$2">
                <Text fontSize="$3" fontWeight="500" color="$gray11">
                  Model
                </Text>
                <TouchableOpacity
                  onPress={onOpenModelPicker}
                  style={{
                    backgroundColor: 'rgba(39, 39, 42, 0.5)',
                    borderWidth: 1,
                    borderColor: 'rgba(63, 63, 70, 0.5)',
                    borderRadius: 8,
                    padding: 12,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <Text style={{ color: '#e4e4e7', fontSize: 14 }}>
                    {selectedModel?.name || modelId}
                  </Text>
                  <ChevronDown size={16} color="#71717a" />
                </TouchableOpacity>
                <Text fontSize="$1" color="$gray10">
                  Current: {modelId}
                </Text>
              </YStack>

              {/* Temperature */}
              <YStack gap="$2">
                <XStack alignItems="center" gap="$2">
                  <ThermometerSun size={16} color="$gray11" />
                  <Text fontSize="$3" fontWeight="500" color="$gray11">
                    Temperature
                  </Text>
                </XStack>
                <Input
                  value={temperature}
                  onChangeText={setTemperature}
                  placeholder="0.7 (leave empty for model default)"
                  keyboardType="decimal-pad"
                  backgroundColor="rgba(39, 39, 42, 0.5)"
                  borderColor="rgba(63, 63, 70, 0.5)"
                />
                <Text fontSize="$1" color="$gray10">
                  Controls randomness. Lower = more focused, higher = more creative.
                </Text>
              </YStack>

              {/* Max Tokens */}
              <YStack gap="$2">
                <XStack alignItems="center" gap="$2">
                  <Hash size={16} color="$gray11" />
                  <Text fontSize="$3" fontWeight="500" color="$gray11">
                    Max Tokens
                  </Text>
                </XStack>
                <Input
                  value={maxTokens}
                  onChangeText={setMaxTokens}
                  placeholder="8192 (leave empty for model default)"
                  keyboardType="number-pad"
                  backgroundColor="rgba(39, 39, 42, 0.5)"
                  borderColor="rgba(63, 63, 70, 0.5)"
                />
                <Text fontSize="$1" color="$gray10">
                  Maximum tokens in the response.
                </Text>
              </YStack>

              {/* System Prompt */}
              <YStack gap="$2">
                <Text fontSize="$3" fontWeight="500" color="$gray11">
                  System Prompt
                </Text>
                <TextArea
                  value={systemPrompt}
                  onChangeText={setSystemPrompt}
                  placeholder="Enter system prompt..."
                  backgroundColor="rgba(39, 39, 42, 0.5)"
                  borderColor="rgba(63, 63, 70, 0.5)"
                  minHeight={200}
                  fontSize="$2"
                  fontFamily={Platform.OS === 'web' ? 'monospace' : '$mono'}
                />
                <Text fontSize="$1" color="$gray10">
                  {systemPrompt.length} characters
                </Text>
              </YStack>
            </YStack>
          </ScrollView>

          {/* Actions */}
          <XStack gap="$3" justifyContent="flex-end" paddingTop="$2">
            <Button variant="outlined" onPress={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              backgroundColor="#06B6D4"
              color="white"
              icon={saving ? <AppSpinner size="sm" /> : <Save size={16} />}
              onPress={handleSave}
              disabled={saving}
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </Button>
          </XStack>
        </YStack>
      </Sheet.Frame>
    </Sheet>
  );
}

interface AgentCoreCardProps {
  core: AgentCore;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
}

function AgentCoreCard({ core, expanded, onToggle, onEdit }: AgentCoreCardProps) {
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
        <Avatar circular size={44}>
          <Avatar.Image src={core.avatarUrl} />
          <Avatar.Fallback
            backgroundColor="rgba(6, 182, 212, 0.2)"
            justifyContent="center"
            alignItems="center"
            delayMs={0}
          >
            <User size={22} color="#06B6D4" />
          </Avatar.Fallback>
        </Avatar>

        <YStack flex={1}>
          <XStack alignItems="center" gap="$2">
            <Text fontSize="$4" fontWeight="600" color="$color">
              {core.fullName}
            </Text>
            <Badge color={STATUS_COLORS[core.status]}>{core.status}</Badge>
          </XStack>
          <XStack alignItems="center" gap="$2">
            <Text fontSize="$2" color="$gray11">
              {core.coreId}
            </Text>
            <Text fontSize="$2" color="$gray10">
              •
            </Text>
            <Text fontSize="$2" color="$gray11">
              {core.version}
            </Text>
            <Text fontSize="$2" color="$gray10">
              •
            </Text>
            <Text fontSize="$2" color="#06B6D4">
              {core.modelId}
            </Text>
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
        <YStack padding="$3" paddingTop={0} gap="$4">
          <Separator backgroundColor="rgba(39, 39, 42, 0.5)" />

          {/* Personality */}
          {core.personality.length > 0 && (
            <YStack gap="$2">
              <XStack alignItems="center" gap="$2">
                <Sparkles size={14} color="#A855F7" />
                <Text fontSize="$2" fontWeight="500" color="$gray11">
                  Personality
                </Text>
              </XStack>
              <XStack flexWrap="wrap" gap="$2">
                {core.personality.map((trait, i) => (
                  <Badge key={i} color="#A855F7">
                    {trait}
                  </Badge>
                ))}
              </XStack>
            </YStack>
          )}

          {/* Capabilities */}
          {core.capabilities.length > 0 && (
            <YStack gap="$2">
              <XStack alignItems="center" gap="$2">
                <Wrench size={14} color="#06B6D4" />
                <Text fontSize="$2" fontWeight="500" color="$gray11">
                  Capabilities
                </Text>
              </XStack>
              <XStack flexWrap="wrap" gap="$2">
                {core.capabilities.map((cap, i) => (
                  <Badge key={i} color="#06B6D4">
                    {cap}
                  </Badge>
                ))}
              </XStack>
            </YStack>
          )}

          {/* Model Configuration */}
          <YStack gap="$2">
            <XStack alignItems="center" gap="$2">
              <Cpu size={14} color="#F59E0B" />
              <Text fontSize="$2" fontWeight="500" color="$gray11">
                Model Configuration
              </Text>
            </XStack>
            <XStack
              backgroundColor="rgba(39, 39, 42, 0.3)"
              padding="$3"
              borderRadius="$2"
              gap="$4"
              flexWrap="wrap"
            >
              <YStack minWidth={120}>
                <Text fontSize="$1" color="$gray10">
                  Model
                </Text>
                <Text fontSize="$3" color="#06B6D4" fontFamily="$mono">
                  {core.modelId}
                </Text>
              </YStack>
              {core.modelOverrides?.temperature !== undefined && (
                <YStack minWidth={100}>
                  <XStack alignItems="center" gap="$1">
                    <ThermometerSun size={12} color="$gray10" />
                    <Text fontSize="$1" color="$gray10">
                      Temperature
                    </Text>
                  </XStack>
                  <Text fontSize="$3" color="$color">
                    {core.modelOverrides.temperature}
                  </Text>
                </YStack>
              )}
              {core.modelOverrides?.maxTokens !== undefined && (
                <YStack minWidth={100}>
                  <XStack alignItems="center" gap="$1">
                    <Hash size={12} color="$gray10" />
                    <Text fontSize="$1" color="$gray10">
                      Max Tokens
                    </Text>
                  </XStack>
                  <Text fontSize="$3" color="$color">
                    {core.modelOverrides.maxTokens.toLocaleString()}
                  </Text>
                </YStack>
              )}
              {!core.modelOverrides?.temperature && !core.modelOverrides?.maxTokens && (
                <Text fontSize="$2" color="$gray10" fontStyle="italic">
                  Using model defaults
                </Text>
              )}
            </XStack>
          </YStack>

          {/* System Prompt Preview */}
          <YStack gap="$2">
            <Text fontSize="$2" fontWeight="500" color="$gray11">
              System Prompt Preview
            </Text>
            <YStack
              backgroundColor="rgba(39, 39, 42, 0.3)"
              padding="$3"
              borderRadius="$2"
              maxHeight={150}
            >
              <Text fontSize="$2" color="$gray11" numberOfLines={6}>
                {core.systemPrompt.substring(0, 500)}
                {core.systemPrompt.length > 500 ? '...' : ''}
              </Text>
            </YStack>
          </YStack>

          {/* Edit Button */}
          <XStack justifyContent="flex-end">
            <Button
              size="$3"
              icon={<Pencil size={16} />}
              backgroundColor="rgba(6, 182, 212, 0.15)"
              borderColor="rgba(6, 182, 212, 0.3)"
              color="#06B6D4"
              onPress={(e: any) => {
                e.stopPropagation();
                onEdit();
              }}
            >
              Edit Configuration
            </Button>
          </XStack>

          {/* ID */}
          <Text fontSize="$1" color="$gray10" fontFamily="$mono">
            ID: {core.coreId}
          </Text>
        </YStack>
      )}
    </YStack>
  );
}

export interface AgentCoresWindowContentProps {
  windowId: string;
}

export function AgentCoresWindowContent({ windowId }: AgentCoresWindowContentProps) {
  const client = getTerosClient();

  const [cores, setCores] = useState<AgentCore[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedCores, setExpandedCores] = useState<Set<string>>(new Set());
  const [editingCore, setEditingCore] = useState<AgentCore | null>(null);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<string>('');

  const toggleCore = (coreId: string) => {
    setExpandedCores((prev) => {
      const next = new Set(prev);
      if (next.has(coreId)) {
        next.delete(coreId);
      } else {
        next.add(coreId);
      }
      return next;
    });
  };

  const loadData = async () => {
    try {
      const [coresList, modelsList] = await Promise.all([
        client.agent.listCores().then((r) => r.cores),
        client.provider.listModels(),
      ]);
      setCores(coresList as AgentCore[]);
      setModels(modelsList.models as Model[]);
    } catch (err) {
      console.error('Failed to load data:', err);
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (client.isConnected()) {
      loadData();
    } else {
      const onConnected = () => {
        loadData();
        client.off('connected', onConnected);
      };
      client.on('connected', onConnected);

      return () => {
        client.off('connected', onConnected);
      };
    }
  }, [client]);

  const handleSaveCore = async (updates: Partial<AgentCore>) => {
    if (!editingCore) return;

    await client.updateAgentCore(editingCore.coreId, updates);

    // Refresh the list
    const coresList = await client.agent.listCores().then((r) => r.cores);
    setCores(coresList as AgentCore[]);
  };

  if (loading) {
    return (
      <FullscreenLoader variant="default" label="Loading agent cores..." />
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

  const activeCores = cores.filter((c) => c.status === 'active').length;

  return (
    <YStack flex={1} backgroundColor="$background">
      {/* Content */}
      <ScrollView flex={1}>
        <YStack padding="$4" gap="$4">
          {/* Summary */}
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
                {cores.length}
              </Text>
              <Text fontSize="$2" color="$gray11">
                Total Cores
              </Text>
            </YStack>
            <YStack flex={1} minWidth={100}>
              <Text fontSize="$6" fontWeight="700" color="#22C55E">
                {activeCores}
              </Text>
              <Text fontSize="$2" color="$gray11">
                Active
              </Text>
            </YStack>
            <YStack flex={1} minWidth={100}>
              <Text fontSize="$6" fontWeight="700" color="#71717A">
                {cores.length - activeCores}
              </Text>
              <Text fontSize="$2" color="$gray11">
                Inactive
              </Text>
            </YStack>
          </XStack>

          {/* Cores List */}
          <YStack gap="$3">
            {cores.map((core) => (
              <AgentCoreCard
                key={core.coreId}
                core={core}
                expanded={expandedCores.has(core.coreId)}
                onToggle={() => toggleCore(core.coreId)}
                onEdit={() => setEditingCore(core)}
              />
            ))}

            {cores.length === 0 && (
              <YStack padding="$6" alignItems="center">
                <Cpu size={48} color="$gray8" />
                <Text color="$gray10" marginTop="$3" textAlign="center">
                  No agent cores configured yet
                </Text>
              </YStack>
            )}
          </YStack>
        </YStack>
      </ScrollView>

      {/* Edit Modal */}
      {editingCore && (
        <EditModal
          core={editingCore}
          models={models}
          open={!!editingCore}
          onClose={() => setEditingCore(null)}
          onSave={handleSaveCore}
          onOpenModelPicker={() => {
            setSelectedModelId(editingCore.modelId);
            setShowModelPicker(true);
          }}
          selectedModelId={selectedModelId}
        />
      )}

      {/* Model Picker - Using Portal to render at document.body level */}
      {showModelPicker && (
        <Portal>
          <View style={portalStyles.overlay}>
            <TouchableOpacity
              style={portalStyles.backdrop}
              activeOpacity={1}
              onPress={() => setShowModelPicker(false)}
            />
            <View style={portalStyles.content}>
              <View style={portalStyles.header}>
                <Text style={portalStyles.headerText}>Select Model</Text>
                <TouchableOpacity onPress={() => setShowModelPicker(false)}>
                  <X size={20} color="#71717a" />
                </TouchableOpacity>
              </View>
              <FlatList
                data={models.filter((m) => m.status === 'active')}
                keyExtractor={(item) => item.modelId}
                style={{ maxHeight: 350 }}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    onPress={() => {
                      setSelectedModelId(item.modelId);
                      setShowModelPicker(false);
                    }}
                    style={[
                      portalStyles.item,
                      item.modelId === selectedModelId && portalStyles.itemSelected,
                    ]}
                  >
                    <View>
                      <Text style={portalStyles.itemName}>{item.name}</Text>
                      <Text style={portalStyles.itemProvider}>{item.provider}</Text>
                    </View>
                    {item.modelId === selectedModelId && <Check size={18} color="#06B6D4" />}
                  </TouchableOpacity>
                )}
              />
            </View>
          </View>
        </Portal>
      )}
    </YStack>
  );
}

const portalStyles = StyleSheet.create({
  overlay: {
    position: 'absolute' as any,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 999999,
    justifyContent: 'center',
    alignItems: 'center',
  },
  backdrop: {
    position: 'absolute' as any,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
  },
  content: {
    backgroundColor: '#18181b',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#27272a',
    width: '90%',
    maxWidth: 400,
    maxHeight: '80%',
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#27272a',
  },
  headerText: {
    color: '#e4e4e7',
    fontSize: 16,
    fontWeight: '600',
  },
  item: {
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(39, 39, 42, 0.5)',
  },
  itemSelected: {
    backgroundColor: 'rgba(6, 182, 212, 0.15)',
  },
  itemName: {
    color: '#e4e4e7',
    fontSize: 14,
    fontWeight: '500',
  },
  itemProvider: {
    color: '#71717a',
    fontSize: 12,
    marginTop: 2,
  },
});
