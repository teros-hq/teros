/**
 * Create Agent Window Content
 *
 * Shows role templates grid. When user selects a role,
 * creates the agent and replaces this window with the agent config.
 */

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
  Sparkles,
  User,
  Workflow,
} from "@tamagui/lucide-icons"
import React, { useEffect, useState } from "react"
import { ScrollView } from "react-native"
import { Text, XStack, YStack } from "tamagui"
import { getTerosClient } from "../../../app/_layout"
import { AppSpinner } from "../../components/ui"
import { generateRandomPersonality } from "../../data/agentPersonalities"
import { useNavbarStore } from "../../store/navbarStore"
import { useTilingStore } from "../../store/tilingStore"

// ============================================================================
// AGENT ROLE TEMPLATES
// ============================================================================

interface AgentRoleTemplate {
  id: string
  name: string
  description: string
  icon: LucideIcon
  color: string
  role: string
  intro: string
  responseStyle: string
}

const AGENT_ROLE_TEMPLATES: AgentRoleTemplate[] = [
  {
    id: "personal-assistant",
    name: "Personal Assistant",
    description: "General help, tasks, organization",
    icon: User,
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
    icon: Briefcase,
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
    icon: Code,
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
    icon: Server,
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
    icon: Bug,
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
    icon: Workflow,
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
    icon: BarChart3,
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
    icon: Palette,
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
    icon: FileText,
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
    icon: Shield,
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
    icon: Megaphone,
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
    icon: Headphones,
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

const DEFAULT_CORE_ID = "iria"

interface Props {
  windowId: string
  workspaceId?: string
}

export function CreateAgentWindowContent({ windowId, workspaceId }: Props) {
  const client = getTerosClient()
  const { replaceWindow, closeWindow } = useTilingStore()
  const { addAgent } = useNavbarStore()

  const [creating, setCreating] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [existingNames, setExistingNames] = useState<string[]>([])

  // Load existing agent names on mount
  useEffect(() => {
    if (client) {
      client.agent
        .listAgents()
        .then(({ agents }) => {
          setExistingNames(agents.map((a) => a.name.split(' ')[0]));
        })
        .catch(console.error)
    }
  }, [client])

  const handleSelectRole = async (template: AgentRoleTemplate) => {
    if (!client || creating) return

    setCreating(template.id)
    setError(null)

    try {
      // Generate random personality (name + avatar)
      const personality = generateRandomPersonality(existingNames)

      // Create the agent
      const createdAgent = await client.createAgent({
        coreId: DEFAULT_CORE_ID,
        name: personality.firstName,
        fullName: personality.fullName,
        role: template.role,
        intro: template.intro,
        avatarUrl: personality.avatar,
        workspaceId,
        context: template.responseStyle,
      })

      // Add to navbar
      addAgent({
        agentId: createdAgent.agentId,
        name: createdAgent.fullName || createdAgent.name,
        avatarUrl: createdAgent.avatarUrl,
        coreId: createdAgent.coreId,
        workspaceId: createdAgent.workspaceId,
      })

      // Replace this window with agent config
      replaceWindow(windowId, "agent", {
        agentId: createdAgent.agentId,
        workspaceId: createdAgent.workspaceId,
      })
    } catch (err: any) {
      console.error("Failed to create agent:", err)
      setError(err.message || "Failed to create agent")
      setCreating(null)
    }
  }

  const handleCustom = () => {
    // TODO: Open a form for custom agent creation
    // For now, just create a Personal Assistant
    handleSelectRole(AGENT_ROLE_TEMPLATES[0])
  }

  return (
    <YStack flex={1} backgroundColor="#0a0a0b">
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
        <Text
          fontSize={11}
          color="#666"
          marginBottom={16}
          fontWeight="600"
          textTransform="uppercase"
          letterSpacing={0.5}
        >
          Elige un rol para tu agente
        </Text>

        {error && (
          <XStack
            backgroundColor="rgba(239, 68, 68, 0.1)"
            padding={12}
            borderRadius={8}
            marginBottom={16}
          >
            <Text color="#EF4444" fontSize={13}>
              {error}
            </Text>
          </XStack>
        )}

        <XStack flexWrap="wrap" gap={10}>
          {AGENT_ROLE_TEMPLATES.map((template) => {
            const Icon = template.icon
            const isCreating = creating === template.id

            return (
              <XStack
                key={template.id}
                width="48%"
                minWidth={200}
                padding={12}
                gap={10}
                alignItems="center"
                backgroundColor="rgba(113, 113, 122, 0.1)"
                borderRadius={8}
                borderWidth={1}
                borderColor="rgba(113, 113, 122, 0.2)"
                cursor={creating ? "default" : "pointer"}
                opacity={creating && !isCreating ? 0.5 : 1}
                hoverStyle={!creating ? { backgroundColor: "rgba(113, 113, 122, 0.15)" } : {}}
                pressStyle={!creating ? { backgroundColor: "rgba(113, 113, 122, 0.2)" } : {}}
                onPress={() => handleSelectRole(template)}
                disabled={!!creating}
              >
                <XStack
                  width={40}
                  height={40}
                  borderRadius={8}
                  backgroundColor={`${template.color}20`}
                  justifyContent="center"
                  alignItems="center"
                >
                  {isCreating ? (
                    <AppSpinner size="sm" color={template.color} />
                  ) : (
                    <Icon size={20} color={template.color} />
                  )}
                </XStack>
                <YStack flex={1}>
                  <Text color="#F4F4F5" fontSize={13} fontWeight="600">
                    {template.name}
                  </Text>
                  <Text color="#71717A" fontSize={11}>
                    {template.description}
                  </Text>
                </YStack>
              </XStack>
            )
          })}
        </XStack>

        {/* Custom option */}
        <XStack justifyContent="center" marginTop={20} paddingVertical={8}>
          <Text
            color="#8B5CF6"
            fontSize={13}
            cursor={creating ? "default" : "pointer"}
            opacity={creating ? 0.5 : 1}
            hoverStyle={!creating ? { opacity: 0.8 } : {}}
            onPress={handleCustom}
          >
            O crea un agente personalizado...
          </Text>
        </XStack>
      </ScrollView>
    </YStack>
  )
}
