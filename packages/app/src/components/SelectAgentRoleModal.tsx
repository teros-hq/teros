import {
  BarChart3,
  Briefcase,
  Bug,
  Code,
  FileText,
  Headphones,
  type LucideIcon,
  Megaphone,
  Palette,
  Server,
  Shield,
  User,
  Workflow,
} from '@tamagui/lucide-icons';
import React from 'react';
import {
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

// ============================================================================
// AGENT ROLE TEMPLATES
// ============================================================================

export interface AgentRoleTemplate {
  id: string;
  name: string;
  description: string;
  icon: LucideIcon;
  color: string;
  role: string;
  intro: string;
  responseStyle: string;
}

export const AGENT_ROLE_TEMPLATES: AgentRoleTemplate[] = [
  {
    id: 'personal-assistant',
    name: 'Personal Assistant',
    description: 'General help, tasks, organization',
    icon: User,
    color: '#8B5CF6',
    role: 'Personal Assistant',
    intro: `I'm your Personal Assistant, ready to help with any task you need.

I can help with:
- Task management and organization
- Research and information gathering
- Writing and editing documents
- Scheduling and reminders
- General problem-solving`,
    responseStyle: 'friendly',
  },
  {
    id: 'product-manager',
    name: 'Product Manager',
    description: 'Roadmaps, features, user stories',
    icon: Briefcase,
    color: '#6366F1',
    role: 'Product Manager',
    intro: `I'm your Product Manager assistant, helping you define and prioritize product strategy.

I can help with:
- Creating and managing product roadmaps
- Writing user stories and requirements
- Prioritizing features and backlog management
- Stakeholder communication and alignment
- Market analysis and competitive research`,
    responseStyle: 'strategic',
  },
  {
    id: 'fullstack-developer',
    name: 'Fullstack Developer',
    description: 'Frontend, backend, APIs, databases',
    icon: Code,
    color: '#14B8A6',
    role: 'Fullstack Developer',
    intro: `I'm your Fullstack Developer assistant, ready to help with any coding task.

I can help with:
- Frontend development (React, Vue, etc.)
- Backend APIs and services
- Database design and queries
- Code review and debugging
- Architecture decisions`,
    responseStyle: 'practical',
  },
  {
    id: 'devops-engineer',
    name: 'DevOps Engineer',
    description: 'CI/CD, infrastructure, deployments',
    icon: Server,
    color: '#F97316',
    role: 'DevOps Engineer',
    intro: `I'm your DevOps Engineer assistant, focused on infrastructure and deployment automation.

I can help with:
- Setting up CI/CD pipelines
- Infrastructure as code (Terraform, Pulumi)
- Container orchestration (Docker, Kubernetes)
- Monitoring and observability
- Cloud services (AWS, GCP, Azure)`,
    responseStyle: 'technical',
  },
  {
    id: 'qa-tester',
    name: 'QA Tester',
    description: 'Testing, automation, quality',
    icon: Bug,
    color: '#A855F7',
    role: 'QA Tester',
    intro: `I'm your QA Tester assistant, focused on software quality and testing.

I can help with:
- Test case design and planning
- Manual and automated testing
- Bug reporting and tracking
- Test automation frameworks
- Quality metrics and coverage`,
    responseStyle: 'meticulous',
  },
  {
    id: 'automation-specialist',
    name: 'Automation Specialist',
    description: 'Workflows, integrations, scripts',
    icon: Workflow,
    color: '#06B6D4',
    role: 'Automation Specialist',
    intro: `I'm your Automation Specialist, helping you streamline workflows and processes.

I can help with:
- Workflow automation (n8n, Zapier, Make)
- Script writing and automation
- API integrations
- Process optimization
- Repetitive task elimination`,
    responseStyle: 'efficient',
  },
  {
    id: 'data-analyst',
    name: 'Data Analyst',
    description: 'Metrics, dashboards, insights',
    icon: BarChart3,
    color: '#10B981',
    role: 'Data Analyst',
    intro: `I'm your Data Analyst assistant, helping you make sense of your data.

I can help with:
- Data analysis and visualization
- Building dashboards and reports
- SQL queries and data extraction
- KPI definition and tracking
- Statistical analysis and insights`,
    responseStyle: 'analytical',
  },
  {
    id: 'ux-designer',
    name: 'UX Designer',
    description: 'Interfaces, wireframes, usability',
    icon: Palette,
    color: '#EC4899',
    role: 'UX Designer',
    intro: `I'm your UX Designer assistant, focused on creating great user experiences.

I can help with:
- User interface design and wireframing
- User flow optimization
- Usability analysis and improvements
- Design system guidance
- Accessibility best practices`,
    responseStyle: 'creative',
  },
  {
    id: 'technical-writer',
    name: 'Technical Writer',
    description: 'Documentation, APIs, guides',
    icon: FileText,
    color: '#64748B',
    role: 'Technical Writer',
    intro: `I'm your Technical Writer assistant, helping you create clear documentation.

I can help with:
- API documentation
- User guides and tutorials
- README files and changelogs
- Technical specifications
- Knowledge base articles`,
    responseStyle: 'clear',
  },
  {
    id: 'security-analyst',
    name: 'Security Analyst',
    description: 'Audits, vulnerabilities, compliance',
    icon: Shield,
    color: '#EF4444',
    role: 'Security Analyst',
    intro: `I'm your Security Analyst assistant, focused on keeping your systems secure.

I can help with:
- Security audits and assessments
- Vulnerability analysis
- Compliance requirements (SOC2, GDPR)
- Security best practices
- Incident response planning`,
    responseStyle: 'thorough',
  },
  {
    id: 'marketing-specialist',
    name: 'Marketing Specialist',
    description: 'Campaigns, copywriting, SEO',
    icon: Megaphone,
    color: '#F59E0B',
    role: 'Marketing Specialist',
    intro: `I'm your Marketing Specialist assistant, helping you grow your audience.

I can help with:
- Marketing campaign planning
- Copywriting and content creation
- SEO optimization
- Social media strategy
- Analytics and performance tracking`,
    responseStyle: 'persuasive',
  },
  {
    id: 'customer-support',
    name: 'Customer Support',
    description: 'Help desk, FAQs, problem solving',
    icon: Headphones,
    color: '#3B82F6',
    role: 'Customer Support Specialist',
    intro: `I'm your Customer Support assistant, focused on helping users succeed.

I can help with:
- Drafting support responses
- Creating FAQ documentation
- Troubleshooting common issues
- Escalation procedures
- Customer satisfaction improvement`,
    responseStyle: 'empathetic',
  },
];

// ============================================================================
// COMPONENT
// ============================================================================

interface SelectAgentRoleModalProps {
  visible: boolean;
  onClose: () => void;
  onSelectRole: (template: AgentRoleTemplate) => void;
  onSelectCustom: () => void;
}

export function SelectAgentRoleModal({
  visible,
  onClose,
  onSelectRole,
  onSelectCustom,
}: SelectAgentRoleModalProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.modal} onPress={(e) => e.stopPropagation()}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>Create New Agent</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <Text style={styles.closeButtonText}>✕</Text>
            </TouchableOpacity>
          </View>

          {/* Content */}
          <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
            <Text style={styles.subtitle}>Choose a role for your agent</Text>

            <View style={styles.rolesGrid}>
              {AGENT_ROLE_TEMPLATES.map((template) => {
                const Icon = template.icon;
                return (
                  <TouchableOpacity
                    key={template.id}
                    style={styles.roleCard}
                    onPress={() => onSelectRole(template)}
                    activeOpacity={0.7}
                  >
                    <View style={[styles.roleIcon, { backgroundColor: `${template.color}20` }]}>
                      <Icon size={20} color={template.color} />
                    </View>
                    <View style={styles.roleInfo}>
                      <Text style={styles.roleName}>{template.name}</Text>
                      <Text style={styles.roleDescription}>{template.description}</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          </ScrollView>

          {/* Footer with custom option */}
          <View style={styles.footer}>
            <TouchableOpacity
              style={styles.customButton}
              onPress={onSelectCustom}
              activeOpacity={0.7}
            >
              <Text style={styles.customButtonText}>Or create a custom agent...</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ============================================================================
// STYLES
// ============================================================================

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
    maxWidth: 560,
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
    maxHeight: 450,
  },
  subtitle: {
    color: '#A1A1AA',
    fontSize: 14,
    marginBottom: 16,
  },
  rolesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  roleCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(113, 113, 122, 0.1)',
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(113, 113, 122, 0.2)',
    width: '48.5%',
    minWidth: 200,
  },
  roleIcon: {
    width: 40,
    height: 40,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 10,
  },
  roleInfo: {
    flex: 1,
  },
  roleName: {
    color: '#F4F4F5',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 2,
  },
  roleDescription: {
    color: '#71717A',
    fontSize: 11,
  },
  footer: {
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(113, 113, 122, 0.2)',
    alignItems: 'center',
  },
  customButton: {
    paddingVertical: 8,
  },
  customButtonText: {
    color: '#8B5CF6',
    fontSize: 13,
  },
});
