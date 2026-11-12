/**
 * SelectAgentRoleModal — pick a role template for a new agent.
 *
 * OS prototype vocabulary (design-testing): a centred card on a dim overlay,
 * serif title, a 2-column grid of role cards (Phosphor tile + name + sub) and
 * a ghost "custom" action. Colours come from `useColors()`.
 */
import React from "react"
import { useTranslation } from "react-i18next"
import { Modal, Platform, Pressable, ScrollView, View, useWindowDimensions } from "react-native"
import { useColors } from "./mca/primitives/useColors"
import { Btn, Card, IconBtn, Ph, T } from "./ui/ds"

// ============================================================================
// AGENT ROLE TEMPLATES
// ============================================================================

export interface AgentRoleTemplate {
  id: string
  name: string
  description: string
  /** Phosphor icon name (kebab-case). */
  icon: string
  color: string
  role: string
  intro: string
  responseStyle: string
}

export const AGENT_ROLE_TEMPLATES: AgentRoleTemplate[] = [
  {
    id: "personal-assistant",
    name: "Personal Assistant",
    description: "General help, tasks, organization",
    icon: "user",
    color: "#8B5CF6",
    role: "Personal Assistant",
    intro: `I'm your Personal Assistant, ready to help with any task you need.

I can help with:
- Task management and organization
- Research and information gathering
- Writing and editing documents
- Scheduling and reminders
- General problem-solving`,
    responseStyle: "friendly",
  },
  {
    id: "product-manager",
    name: "Product Manager",
    description: "Roadmaps, features, user stories",
    icon: "briefcase",
    color: "#6366F1",
    role: "Product Manager",
    intro: `I'm your Product Manager assistant, helping you define and prioritize product strategy.

I can help with:
- Creating and managing product roadmaps
- Writing user stories and requirements
- Prioritizing features and backlog management
- Stakeholder communication and alignment
- Market analysis and competitive research`,
    responseStyle: "strategic",
  },
  {
    id: "fullstack-developer",
    name: "Fullstack Developer",
    description: "Frontend, backend, APIs, databases",
    icon: "code",
    color: "#14B8A6",
    role: "Fullstack Developer",
    intro: `I'm your Fullstack Developer assistant, ready to help with any coding task.

I can help with:
- Frontend development (React, Vue, etc.)
- Backend APIs and services
- Database design and queries
- Code review and debugging
- Architecture decisions`,
    responseStyle: "practical",
  },
  {
    id: "devops-engineer",
    name: "DevOps Engineer",
    description: "CI/CD, infrastructure, deployments",
    icon: "hard-drives",
    color: "#F97316",
    role: "DevOps Engineer",
    intro: `I'm your DevOps Engineer assistant, focused on infrastructure and deployment automation.

I can help with:
- Setting up CI/CD pipelines
- Infrastructure as code (Terraform, Pulumi)
- Container orchestration (Docker, Kubernetes)
- Monitoring and observability
- Cloud services (AWS, GCP, Azure)`,
    responseStyle: "technical",
  },
  {
    id: "qa-tester",
    name: "QA Tester",
    description: "Testing, automation, quality",
    icon: "bug",
    color: "#A855F7",
    role: "QA Tester",
    intro: `I'm your QA Tester assistant, focused on software quality and testing.

I can help with:
- Test case design and planning
- Manual and automated testing
- Bug reporting and tracking
- Test automation frameworks
- Quality metrics and coverage`,
    responseStyle: "meticulous",
  },
  {
    id: "automation-specialist",
    name: "Automation Specialist",
    description: "Workflows, integrations, scripts",
    icon: "flow-arrow",
    color: "#06B6D4",
    role: "Automation Specialist",
    intro: `I'm your Automation Specialist, helping you streamline workflows and processes.

I can help with:
- Workflow automation (n8n, Zapier, Make)
- Script writing and automation
- API integrations
- Process optimization
- Repetitive task elimination`,
    responseStyle: "efficient",
  },
  {
    id: "data-analyst",
    name: "Data Analyst",
    description: "Metrics, dashboards, insights",
    icon: "chart-bar",
    color: "#10B981",
    role: "Data Analyst",
    intro: `I'm your Data Analyst assistant, helping you make sense of your data.

I can help with:
- Data analysis and visualization
- Building dashboards and reports
- SQL queries and data extraction
- KPI definition and tracking
- Statistical analysis and insights`,
    responseStyle: "analytical",
  },
  {
    id: "ux-designer",
    name: "UX Designer",
    description: "Interfaces, wireframes, usability",
    icon: "palette",
    color: "#EC4899",
    role: "UX Designer",
    intro: `I'm your UX Designer assistant, focused on creating great user experiences.

I can help with:
- User interface design and wireframing
- User flow optimization
- Usability analysis and improvements
- Design system guidance
- Accessibility best practices`,
    responseStyle: "creative",
  },
  {
    id: "technical-writer",
    name: "Technical Writer",
    description: "Documentation, APIs, guides",
    icon: "file-text",
    color: "#64748B",
    role: "Technical Writer",
    intro: `I'm your Technical Writer assistant, helping you create clear documentation.

I can help with:
- API documentation
- User guides and tutorials
- README files and changelogs
- Technical specifications
- Knowledge base articles`,
    responseStyle: "clear",
  },
  {
    id: "security-analyst",
    name: "Security Analyst",
    description: "Audits, vulnerabilities, compliance",
    icon: "shield-check",
    color: "#EF4444",
    role: "Security Analyst",
    intro: `I'm your Security Analyst assistant, focused on keeping your systems secure.

I can help with:
- Security audits and assessments
- Vulnerability analysis
- Compliance requirements (SOC2, GDPR)
- Security best practices
- Incident response planning`,
    responseStyle: "thorough",
  },
  {
    id: "marketing-specialist",
    name: "Marketing Specialist",
    description: "Campaigns, copywriting, SEO",
    icon: "megaphone",
    color: "#F59E0B",
    role: "Marketing Specialist",
    intro: `I'm your Marketing Specialist assistant, helping you grow your audience.

I can help with:
- Marketing campaign planning
- Copywriting and content creation
- SEO optimization
- Social media strategy
- Analytics and performance tracking`,
    responseStyle: "persuasive",
  },
  {
    id: "customer-support",
    name: "Customer Support",
    description: "Help desk, FAQs, problem solving",
    icon: "headset",
    color: "#3B82F6",
    role: "Customer Support Specialist",
    intro: `I'm your Customer Support assistant, focused on helping users succeed.

I can help with:
- Drafting support responses
- Creating FAQ documentation
- Troubleshooting common issues
- Escalation procedures
- Customer satisfaction improvement`,
    responseStyle: "empathetic",
  },
]

// ============================================================================
// COMPONENT
// ============================================================================

interface SelectAgentRoleModalProps {
  visible: boolean
  onClose: () => void
  onSelectRole: (template: AgentRoleTemplate) => void
  onSelectCustom: () => void
}

/** One role card of the grid — tile tinted with the template colour. */
export function RoleTemplateCard({
  template,
  onPress,
  busy,
  disabled,
}: {
  template: AgentRoleTemplate
  onPress: () => void
  busy?: boolean
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const c = useColors()
  return (
    <Card
      hov
      accent
      pad
      onPress={onPress}
      disabled={disabled}
      style={{ opacity: disabled && !busy ? 0.5 : 1 }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            backgroundColor: `${template.color}20`,
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          {busy ? (
            <Ph name="circle-notch" size={18} color={template.color} />
          ) : (
            <Ph name={template.icon} size={18} color={template.color} />
          )}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T step="sm" ellipsis>
            {t(`agent.roles.${template.id}`)}
          </T>
          <T step="12" tone="text3" ellipsis>
            {t(`agent.roles.${template.id}Desc`)}
          </T>
        </View>
        <Ph name="caret-right" size={14} color={c.text3} />
      </View>
    </Card>
  )
}

export function SelectAgentRoleModal({
  visible,
  onClose,
  onSelectRole,
  onSelectCustom,
}: SelectAgentRoleModalProps) {
  const { t } = useTranslation()
  const c = useColors()
  const { width } = useWindowDimensions()
  const cols = width <= 620 ? 1 : 2

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        style={{
          flex: 1,
          backgroundColor: "rgba(32,28,39,0.55)",
          justifyContent: "center",
          alignItems: "center",
          padding: 16,
        }}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={[
            {
              width: "100%",
              maxWidth: 640,
              maxHeight: "88%",
              borderRadius: 24,
              backgroundColor: c.bgSheet,
              overflow: "hidden",
            },
            Platform.OS === "web" ? ({ boxShadow: c.elevRaised } as any) : null,
          ]}
        >
          {/* Header */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "flex-start",
              gap: 12,
              padding: 24,
              paddingBottom: 8,
            }}
          >
            <View style={{ flex: 1 }}>
              <T step="xs" tone="accent" style={{ marginBottom: 10 }}>
                {t("agent.createAgent")}
              </T>
              <T step="xl">{t("agent.createNewAgent")}</T>
              <T step="sm" tone="text2" style={{ marginTop: 6 }}>
                {t("agent.chooseRole")}
              </T>
            </View>
            <IconBtn icon="x" plain onPress={onClose} title={t("common.close")} />
          </View>

          {/* Content */}
          <ScrollView
            style={{ maxHeight: 460 }}
            contentContainerStyle={{ padding: 24, paddingTop: 8 }}
            showsVerticalScrollIndicator={false}
          >
            <View style={{ flexDirection: "row", flexWrap: "wrap", marginHorizontal: -5 }}>
              {AGENT_ROLE_TEMPLATES.map((template) => (
                <View
                  key={template.id}
                  style={{ width: `${100 / cols}%`, paddingHorizontal: 5, marginBottom: 10 }}
                >
                  <RoleTemplateCard template={template} onPress={() => onSelectRole(template)} />
                </View>
              ))}
            </View>
          </ScrollView>

          {/* Footer with custom option */}
          <View
            style={{
              padding: 16,
              borderTopWidth: 1,
              borderTopColor: c.border,
              alignItems: "center",
            }}
          >
            <Btn variant="ghost" icon="sparkle" onPress={onSelectCustom}>
              {t("agent.orCreateCustom")}
            </Btn>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}
