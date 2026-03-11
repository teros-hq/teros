import React, { useCallback, useEffect, useState } from 'react';
import {
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { getTerosClient } from '../../app/_layout';
import type { AgentRoleTemplate } from './SelectAgentRoleModal';
import { AppSpinner } from '../components/ui';

// ============================================================================
// AGENT PRESETS - Pre-generated names and intros for each core
// ============================================================================

interface AgentPreset {
  name: string;
  fullName: string;
  role: string;
  intro: string;
  responseStyle: string;
}

const AGENT_PRESETS: Record<string, AgentPreset[]> = {
  // Iria core presets
  iria: [
    {
      name: 'Alice',
      fullName: 'Alice Evergreen',
      role: 'Personal Assistant',
      intro: `I'm Alice Evergreen, your personal assistant focused on software engineering tasks, project management, and technical workflows.

My primary goal is to assist you with software projects and technical infrastructure.
I focus on accuracy, professional objectivity, and efficient execution of tasks.

Primary responsibilities:
- Software development and coding tasks
- Project management and workflow automation
- Technical research and documentation

Secondary responsibilities:
- System administration and DevOps
- Code review and debugging
- Email, calendar, and task management`,
      responseStyle: 'friendly',
    },
    {
      name: 'Berta',
      fullName: 'Berta Thornwood',
      role: 'Technical Advisor',
      intro: `I'm Berta Thornwood, your technical advisor specializing in software architecture and engineering best practices.

I help you make informed technical decisions and implement robust solutions.
My approach combines deep technical knowledge with practical, pragmatic advice.

Primary responsibilities:
- Architecture design and code review
- Technical decision support
- Best practices and standards guidance

Secondary responsibilities:
- Performance optimization
- Security considerations
- Documentation and knowledge sharing`,
      responseStyle: 'professional',
    },
    {
      name: 'Clara',
      fullName: 'Clara Westbrook',
      role: 'Development Partner',
      intro: `I'm Clara Westbrook, your development partner for building and shipping software.

I work alongside you to write code, debug issues, and deliver features efficiently.
I'm hands-on, detail-oriented, and focused on getting things done.

Primary responsibilities:
- Pair programming and code implementation
- Bug fixing and troubleshooting
- Feature development and testing

Secondary responsibilities:
- Code refactoring and optimization
- Build and deployment automation
- Technical documentation`,
      responseStyle: 'collaborative',
    },
    {
      name: 'Diana',
      fullName: 'Diana Ashford',
      role: 'Project Coordinator',
      intro: `I'm Diana Ashford, your project coordinator helping you stay organized and productive.

I help manage tasks, track progress, and ensure nothing falls through the cracks.
I bring structure and clarity to complex projects.

Primary responsibilities:
- Task management and prioritization
- Progress tracking and reporting
- Schedule and deadline management

Secondary responsibilities:
- Meeting coordination
- Documentation organization
- Communication facilitation`,
      responseStyle: 'organized',
    },
    {
      name: 'Elena',
      fullName: 'Elena Blackwood',
      role: 'Research Assistant',
      intro: `I'm Elena Blackwood, your research assistant for technical exploration and analysis.

I help you investigate technologies, analyze options, and synthesize information.
I'm thorough, curious, and good at finding answers.

Primary responsibilities:
- Technical research and analysis
- Technology evaluation and comparison
- Information synthesis and summarization

Secondary responsibilities:
- Documentation and knowledge base
- Trend monitoring
- Learning resource curation`,
      responseStyle: 'analytical',
    },
  ],
  // Add more cores here as needed
  // aurora: [...],
  // nova: [...],
};

// Fallback preset for unknown cores
const DEFAULT_PRESETS: AgentPreset[] = [
  {
    name: 'Alex',
    fullName: 'Alex Sterling',
    role: 'AI Assistant',
    intro: `I'm Alex Sterling, your AI assistant ready to help with a variety of tasks.

I'm here to assist you with whatever you need, adapting to your requirements and preferences.

I can help with:
- General questions and research
- Task organization and planning
- Writing and editing
- Problem-solving and brainstorming`,
    responseStyle: 'adaptive',
  },
  {
    name: 'Jordan',
    fullName: 'Jordan Blake',
    role: 'Digital Helper',
    intro: `I'm Jordan Blake, your digital helper for everyday tasks and projects.

I'm versatile, helpful, and focused on making your work easier.

I can assist with:
- Information lookup and research
- Writing and communication
- Organization and planning
- Creative brainstorming`,
    responseStyle: 'helpful',
  },
];

function getPresetsForCore(coreId: string): AgentPreset[] {
  return AGENT_PRESETS[coreId] || DEFAULT_PRESETS;
}

function getRandomPreset(coreId: string, excludeName?: string): AgentPreset {
  const presets = getPresetsForCore(coreId);
  // Filter out the current name if provided (for refresh)
  const available = excludeName ? presets.filter((p) => p.name !== excludeName) : presets;
  // If all filtered out, use all presets
  const pool = available.length > 0 ? available : presets;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ============================================================================

interface AgentCore {
  coreId: string;
  name: string;
  fullName: string;
  version: string;
  personality: string[];
  capabilities: string[];
  avatarUrl?: string;
  status: string;
}

interface CreateAgentModalProps {
  visible: boolean;
  onClose: () => void;
  onCreated: (agent: {
    agentId: string;
    name: string;
    fullName: string;
    avatarUrl?: string;
    coreId: string;
    workspaceId?: string;
  }) => void;
  /** If true, shows core selection. If false, uses default core (iria) */
  isAdmin?: boolean;
  /** Pre-selected role template from SelectAgentRoleModal */
  roleTemplate?: AgentRoleTemplate | null;
}

const DEFAULT_CORE_ID = 'iria';

export function CreateAgentModal({
  visible,
  onClose,
  onCreated,
  isAdmin = false,
  roleTemplate,
}: CreateAgentModalProps) {
  const client = getTerosClient();

  // State
  const [cores, setCores] = useState<AgentCore[]>([]);
  const [loadingCores, setLoadingCores] = useState(true);
  const [selectedCore, setSelectedCore] = useState<AgentCore | null>(null);
  const [step, setStep] = useState<'select-core' | 'configure'>('select-core');

  // Form fields
  const [name, setName] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState('');
  const [intro, setIntro] = useState('');
  const [responseStyle, setResponseStyle] = useState('');

  const [creating, setCreating] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track existing agent names to exclude from generation
  const [existingNames, setExistingNames] = useState<string[]>([]);

  // Load cores when modal opens
  useEffect(() => {
    if (visible && client) {
      loadExistingAgentNames();
      if (isAdmin && !roleTemplate) {
        // Admin without template: show core selection
        loadCores();
      } else {
        // Non-admin OR has template: load default core and skip to configure
        loadDefaultCoreWithTemplate();
      }
    }
  }, [visible, client, isAdmin, roleTemplate]);

  // Load default core and apply template if provided
  const loadDefaultCoreWithTemplate = async () => {
    if (!client) return;

    setLoadingCores(true);
    try {
      const coresList = await client.agent.listCores().then((r) => r.cores);
      const defaultCore = coresList.find(
        (c) => c.coreId === DEFAULT_CORE_ID && c.status === 'active',
      );
      if (defaultCore) {
        setSelectedCore(defaultCore);
        setStep('configure');

        if (roleTemplate) {
          // Use template data - generate only the name
          setRole(roleTemplate.role);
          setIntro(roleTemplate.intro);
          setResponseStyle(roleTemplate.responseStyle);
          // Generate a unique name for this role
          const agents = await client.agent.listAgents().then((r) => r.agents);
          const names = agents.map((a) => a.name.split(' ')[0]);
          await generateNameOnly(defaultCore.coreId, roleTemplate.role, names);
        } else {
          // No template: generate full profile
          const agents = await client.agent.listAgents().then((r) => r.agents);
          const names = agents.map((a) => a.name.split(' ')[0]);
          await generateProfile(defaultCore.coreId, names);
        }
      } else {
        setError('Default engine not available');
      }
    } catch (err) {
      console.error('Failed to load default core:', err);
      setError('Failed to load agent engine');
    } finally {
      setLoadingCores(false);
    }
  };

  // Generate only name and fullName for a given role
  const generateNameOnly = async (coreId: string, forRole: string, excludeNames: string[]) => {
    if (!client) return;

    setGenerating(true);
    setError(null);

    try {
      const profile = await client.generateAgentProfile(coreId, excludeNames);
      setName(profile.name);
      setFullName(profile.fullName);
      // Keep role, intro, responseStyle from template
    } catch (err: any) {
      console.error('Failed to generate name:', err);
      // Fallback to preset name
      const preset = getRandomPreset(coreId);
      setName(preset.name);
      setFullName(preset.fullName);
    } finally {
      setGenerating(false);
    }
  };

  // Load existing agent names to exclude from generation
  const loadExistingAgentNames = async () => {
    if (!client) return;
    try {
      const agents = await client.agent.listAgents().then((r) => r.agents);
      setExistingNames(agents.map((a) => a.name.split(' ')[0])); // Get first names
    } catch (err) {
      console.error('Failed to load existing agents:', err);
    }
  };

  // Reset state when modal closes
  useEffect(() => {
    if (!visible) {
      setStep('select-core');
      setSelectedCore(null);
      setName('');
      setFullName('');
      setRole('');
      setIntro('');
      setResponseStyle('');
      setError(null);
    }
  }, [visible]);

  const loadCores = async () => {
    if (!client) return;

    setLoadingCores(true);
    try {
      const coresList = await client.agent.listCores().then((r) => r.cores);
      // Filter only active cores
      setCores(coresList.filter((c) => c.status === 'active'));
    } catch (err) {
      console.error('Failed to load cores:', err);
      setError('Failed to load agent engines');
    } finally {
      setLoadingCores(false);
    }
  };

  // Generate a profile using LLM
  const generateProfile = useCallback(
    async (coreId: string, excludeNames: string[]) => {
      if (!client) return;

      setGenerating(true);
      setError(null);

      try {
        const profile = await client.generateAgentProfile(coreId, excludeNames);
        setName(profile.name);
        setFullName(profile.fullName);
        setRole(profile.role);
        setIntro(profile.intro);
        setResponseStyle(profile.responseStyle);
      } catch (err: any) {
        console.error('Failed to generate profile:', err);
        // Fallback to preset if LLM fails
        const preset = getRandomPreset(coreId);
        setName(preset.name);
        setFullName(preset.fullName);
        setRole(preset.role);
        setIntro(preset.intro);
        setResponseStyle(preset.responseStyle);
        setError('Using fallback profile (generation failed)');
      } finally {
        setGenerating(false);
      }
    },
    [client],
  );

  const handleSelectCore = async (core: AgentCore) => {
    setSelectedCore(core);
    setStep('configure');
    // Generate profile with LLM, excluding existing names
    await generateProfile(core.coreId, existingNames);
  };

  const handleBack = () => {
    setStep('select-core');
    setSelectedCore(null);
    setError(null);
  };

  const handleCreate = async () => {
    if (!client || !selectedCore) return;

    // Validate
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    if (!fullName.trim()) {
      setError('Full name is required');
      return;
    }
    if (!role.trim()) {
      setError('Role is required');
      return;
    }
    if (!intro.trim()) {
      setError('Introduction is required');
      return;
    }

    setCreating(true);
    setError(null);

    try {
      const createdAgent = await client.createAgent({
        coreId: selectedCore.coreId,
        name: name.trim(),
        fullName: fullName.trim(),
        role: role.trim(),
        intro: intro.trim(),
        context: responseStyle.trim() || undefined,
      });

      onCreated({
        agentId: createdAgent.agentId,
        name: createdAgent.fullName || createdAgent.name,
        fullName: createdAgent.fullName,
        avatarUrl: createdAgent.avatarUrl,
        coreId: createdAgent.coreId,
        workspaceId: createdAgent.workspaceId,
      });

      onClose();
    } catch (err: any) {
      console.error('Failed to create agent:', err);
      setError(err.message || 'Failed to create agent');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.modal} onPress={(e) => e.stopPropagation()}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>
              {step === 'select-core' ? 'Create New Agent' : 'Configure Agent'}
            </Text>
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <Text style={styles.closeButtonText}>✕</Text>
            </TouchableOpacity>
          </View>

          {/* Content */}
          <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
            {step === 'select-core' ? (
              // Step 1: Select Core
              <View style={styles.coresContainer}>
                <Text style={styles.subtitle}>Select an engine for your agent</Text>

                {loadingCores ? (
                  <View style={styles.loadingContainer}>
                    <AppSpinner size="lg" variant="board" />
                    <Text style={styles.loadingText}>Loading engines...</Text>
                  </View>
                ) : cores.length === 0 ? (
                  <Text style={styles.emptyText}>No engines available</Text>
                ) : (
                  <View style={styles.coresList}>
                    {cores.map((core) => (
                      <TouchableOpacity
                        key={core.coreId}
                        style={styles.coreCard}
                        onPress={() => handleSelectCore(core)}
                        activeOpacity={0.7}
                      >
                        <View style={styles.coreAvatar}>
                          {core.avatarUrl ? (
                            <Image
                              source={{ uri: core.avatarUrl }}
                              style={styles.coreAvatarImage}
                            />
                          ) : (
                            <Text style={styles.coreAvatarText}>
                              {core.name.charAt(0).toUpperCase()}
                            </Text>
                          )}
                        </View>
                        <View style={styles.coreInfo}>
                          <Text style={styles.coreName}>{core.fullName}</Text>
                          <Text style={styles.coreVersion}>{core.version}</Text>
                          <View style={styles.coreTags}>
                            {core.personality.slice(0, 3).map((trait, i) => (
                              <View key={i} style={styles.coreTag}>
                                <Text style={styles.coreTagText}>{trait}</Text>
                              </View>
                            ))}
                          </View>
                        </View>
                        <Text style={styles.coreArrow}>→</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>
            ) : (
              // Step 2: Configure Agent
              <View style={styles.formContainer}>
                {/* Selected Core Info + Shuffle Button */}
                {selectedCore && (
                  <View style={styles.selectedCoreRow}>
                    <View style={styles.selectedCoreInfo}>
                      <View style={styles.selectedCoreAvatar}>
                        {selectedCore.avatarUrl ? (
                          <Image
                            source={{ uri: selectedCore.avatarUrl }}
                            style={styles.selectedCoreAvatarImage}
                          />
                        ) : (
                          <Text style={styles.selectedCoreAvatarText}>
                            {selectedCore.name.charAt(0).toUpperCase()}
                          </Text>
                        )}
                      </View>
                      <View>
                        <Text style={styles.selectedCoreName}>Engine: {selectedCore.fullName}</Text>
                        {isAdmin && (
                          <TouchableOpacity onPress={handleBack} disabled={generating}>
                            <Text style={styles.changeLink}>Change</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>
                  </View>
                )}

                {/* Loading overlay while generating */}
                {generating ? (
                  <View style={styles.generatingOverlay}>
                    <AppSpinner size="lg" variant="board" />
                    <Text style={styles.generatingText}>Generating unique persona...</Text>
                  </View>
                ) : (
                  <>
                    {/* Form Fields */}
                    <View style={styles.formField}>
                      <Text style={styles.label}>Name *</Text>
                      <TextInput
                        style={styles.input}
                        value={name}
                        onChangeText={setName}
                        placeholder="e.g., Alice"
                        placeholderTextColor="#71717A"
                      />
                    </View>

                    <View style={styles.formField}>
                      <Text style={styles.label}>Full Name *</Text>
                      <TextInput
                        style={styles.input}
                        value={fullName}
                        onChangeText={setFullName}
                        placeholder="e.g., Alice Evergreen"
                        placeholderTextColor="#71717A"
                      />
                    </View>

                    <View style={styles.formField}>
                      <Text style={styles.label}>Role *</Text>
                      <TextInput
                        style={styles.input}
                        value={role}
                        onChangeText={setRole}
                        placeholder="e.g., Personal Assistant"
                        placeholderTextColor="#71717A"
                      />
                    </View>

                    <View style={styles.formField}>
                      <Text style={styles.label}>Introduction *</Text>
                      <TextInput
                        style={[styles.input, styles.textArea]}
                        value={intro}
                        onChangeText={setIntro}
                        placeholder="A brief introduction that the agent will use..."
                        placeholderTextColor="#71717A"
                        multiline
                        numberOfLines={4}
                        textAlignVertical="top"
                      />
                    </View>

                    <View style={styles.formField}>
                      <Text style={styles.label}>Response Style (optional)</Text>
                      <TextInput
                        style={styles.input}
                        value={responseStyle}
                        onChangeText={setResponseStyle}
                        placeholder="e.g., friendly, formal, concise"
                        placeholderTextColor="#71717A"
                      />
                    </View>
                  </>
                )}
              </View>
            )}

            {/* Error */}
            {error && (
              <View style={styles.errorContainer}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
          </ScrollView>

          {/* Footer */}
          <View style={styles.footer}>
            {step === 'configure' && (
              <>
                <TouchableOpacity
                  style={styles.secondaryButton}
                  onPress={handleBack}
                  disabled={creating || generating}
                >
                  <Text style={styles.secondaryButtonText}>Back</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.primaryButton, (creating || generating) && styles.buttonDisabled]}
                  onPress={handleCreate}
                  disabled={creating || generating}
                >
                  {creating ? (
                    <AppSpinner size="sm" variant="onDark" />
                  ) : (
                    <Text style={styles.primaryButtonText}>Create Agent</Text>
                  )}
                </TouchableOpacity>
              </>
            )}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modal: {
    backgroundColor: '#18181B',
    borderRadius: 12,
    width: '90%',
    maxWidth: 500,
    maxHeight: '85%',
    borderWidth: 1,
    borderColor: 'rgba(113, 113, 122, 0.3)',
    ...Platform.select({
      web: {
        boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
      },
      default: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 25 },
        shadowOpacity: 0.5,
        shadowRadius: 50,
        elevation: 25,
      },
    }),
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(113, 113, 122, 0.2)',
  },
  title: {
    color: '#F4F4F5',
    fontSize: 18,
    fontWeight: '600',
  },
  closeButton: {
    padding: 4,
  },
  closeButtonText: {
    color: '#71717A',
    fontSize: 20,
  },
  content: {
    padding: 16,
    maxHeight: 400,
  },
  subtitle: {
    color: '#A1A1AA',
    fontSize: 14,
    marginBottom: 16,
  },

  // Cores list
  coresContainer: {},
  loadingContainer: {
    alignItems: 'center',
    padding: 32,
  },
  loadingText: {
    color: '#71717A',
    marginTop: 12,
  },
  emptyText: {
    color: '#71717A',
    textAlign: 'center',
    padding: 32,
  },
  coresList: {
    gap: 12,
  },
  coreCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(113, 113, 122, 0.1)',
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(113, 113, 122, 0.2)',
  },
  coreAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#8B5CF6',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  coreAvatarImage: {
    width: 48,
    height: 48,
    borderRadius: 24,
  },
  coreAvatarText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '600',
  },
  coreInfo: {
    flex: 1,
  },
  coreName: {
    color: '#F4F4F5',
    fontSize: 16,
    fontWeight: '600',
  },
  coreVersion: {
    color: '#71717A',
    fontSize: 12,
    marginBottom: 4,
  },
  coreTags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
  },
  coreTag: {
    backgroundColor: 'rgba(139, 92, 246, 0.2)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  coreTagText: {
    color: '#A78BFA',
    fontSize: 10,
  },
  coreArrow: {
    color: '#71717A',
    fontSize: 20,
    marginLeft: 8,
  },

  // Form
  formContainer: {
    gap: 16,
  },
  selectedCoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(139, 92, 246, 0.1)',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
  },
  selectedCoreInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  generatingOverlay: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 12,
  },
  generatingText: {
    color: '#A1A1AA',
    fontSize: 14,
  },
  selectedCoreAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#8B5CF6',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  selectedCoreAvatarImage: {
    width: 40,
    height: 40,
    borderRadius: 20,
  },
  selectedCoreAvatarText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  selectedCoreName: {
    color: '#E4E4E7',
    fontSize: 14,
    fontWeight: '500',
  },
  changeLink: {
    color: '#8B5CF6',
    fontSize: 12,
    marginTop: 2,
  },
  formField: {
    gap: 6,
  },
  label: {
    color: '#A1A1AA',
    fontSize: 13,
    fontWeight: '500',
  },
  input: {
    backgroundColor: 'rgba(113, 113, 122, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(113, 113, 122, 0.3)',
    borderRadius: 8,
    padding: 12,
    color: '#F4F4F5',
    fontSize: 14,
  },
  textArea: {
    minHeight: 100,
    paddingTop: 12,
  },

  // Error
  errorContainer: {
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderRadius: 8,
    padding: 12,
    marginTop: 16,
  },
  errorText: {
    color: '#EF4444',
    fontSize: 13,
  },

  // Footer
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(113, 113, 122, 0.2)',
  },
  secondaryButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(113, 113, 122, 0.3)',
  },
  secondaryButtonText: {
    color: '#A1A1AA',
    fontSize: 14,
    fontWeight: '500',
  },
  primaryButton: {
    backgroundColor: '#8B5CF6',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    minWidth: 120,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
});
