/**
 * Window Types Registry
 *
 * Registers all available window types in the application.
 * Llamar a registerAllWindowTypes() al inicio de la app.
 */

import { windowRegistry } from "../services/windowRegistry"
import { codeEditorWindowDefinition } from "./CodeEditorWindow"
import { registerCodeEditorHandlers } from "./CodeEditorWindow/registerHandlers"
import { terminalWindowDefinition } from "./TerminalWindow"
import { agentCoresWindowDefinition } from "./AgentCoresWindow"
import { agentWindowDefinition } from "./AgentWindow"
import { boardWindowDefinition } from "./BoardWindow"
import { fileViewerWindowDefinition } from "./FileViewerWindow"
import { fileBrowserWindowDefinition } from "./FileBrowserWindow"
import { markdownViewerWindowDefinition } from "./MarkdownViewerWindow"
import { browserbaseWindowDefinition } from "./BrowserbaseWindow"
import { browserWindowDefinition } from "./BrowserWindow"
import { skillsWindowDefinition } from "./SkillsWindow"
import { academyWindowDefinition } from "./AcademyWindow"
import { projectWindowDefinition } from "./ProjectWindow"
// import { uiTestWindowDefinition } from './UITestWindow/definition';
import { appsWindowDefinition } from "./AppsWindow"
import { appWindowDefinition } from "./AppWindow"
import { archivedConversationsWindowDefinition } from "./ArchivedConversationsWindow"
import { catalogWindowDefinition } from "./CatalogWindow"
import { catalogDetailWindowDefinition } from "./CatalogDetailWindow"
import { chatWindowDefinition } from "./ChatWindow"
import { homeWindowDefinition } from "./HomeWindow"
import { consoleWindowDefinition } from "./ConsoleWindow"
import { conversationsWindowDefinition } from "./ConversationsWindow"
import { createAgentWindowDefinition } from "./CreateAgentWindow"
import { launcherWindowDefinition } from "./LauncherWindow"
import { mcasWindowDefinition } from "./McasWindow"
import { pendingApprovalsWindowDefinition } from "./PendingApprovalsWindow"
import { profileWindowDefinition } from "./ProfileWindow"
import { providersWindowDefinition } from "./ProvidersWindow"
import { agentUsageWindowDefinition } from "./AgentUsageWindow"
import { modelHealthWindowDefinition } from "./ModelHealthWindow"
import { sessionTraceWindowDefinition } from "./SessionTraceWindow"
import { latitudeSignalsWindowDefinition } from "./LatitudeSignalsWindow"
import { billingRequestsWindowDefinition } from "./BillingRequestsWindow"
import { billingAuditWindowDefinition } from "./BillingAuditWindow"
import { billingTeamsWindowDefinition } from "./BillingTeamsWindow"
import { usersWindowDefinition } from "./UsersWindow"
import { workspacesListWindowDefinition } from "./WorkspacesListWindow"
import { agentsListWindowDefinition } from "./AgentsListWindow"
import { projectsListWindowDefinition } from "./ProjectsListWindow"
import { workspaceWindowDefinition } from "./WorkspacesWindow"
import { featureFlagsWindowDefinition } from "./FeatureFlagsWindow"
import { terosProviderWindowDefinition } from "./TerosProviderWindow"
import { feedbackAdminWindowDefinition } from "./FeedbackAdminWindow"
import { automateWindowDefinition } from "./AutomateWindow"
import { monitoringWindowDefinition } from "./MonitoringWindow"
import { todoNodeWindowDefinition, todoWindowDefinition } from "./TodoWindow"
import { flowEditorWindowDefinition } from "./FlowEditorWindow"
import { flowExecutionWindowDefinition } from "./FlowExecutionWindow"
import { flowListWindowDefinition } from "./FlowListWindow"

/**
 * Registra todos los tipos de ventana
 */
export function registerAllWindowTypes(): void {
  // Chat windows
  windowRegistry.register(homeWindowDefinition)
  windowRegistry.register(chatWindowDefinition)

  // Conversations list
  windowRegistry.register(conversationsWindowDefinition)
  windowRegistry.register(archivedConversationsWindowDefinition)

  // Pending approvals
  windowRegistry.register(pendingApprovalsWindowDefinition)

  // Dev tools
  windowRegistry.register(consoleWindowDefinition)

  // Apps management
  windowRegistry.register(appsWindowDefinition)
  windowRegistry.register(catalogWindowDefinition)
  windowRegistry.register(catalogDetailWindowDefinition)
  windowRegistry.register(appWindowDefinition)

  // Agent configuration
  windowRegistry.register(agentWindowDefinition)

  // Admin windows
  windowRegistry.register(agentCoresWindowDefinition)
  windowRegistry.register(mcasWindowDefinition)
  windowRegistry.register(usersWindowDefinition)
  windowRegistry.register(agentUsageWindowDefinition)
  windowRegistry.register(modelHealthWindowDefinition)
  windowRegistry.register(sessionTraceWindowDefinition)
  windowRegistry.register(latitudeSignalsWindowDefinition)
  windowRegistry.register(featureFlagsWindowDefinition)
  windowRegistry.register(terosProviderWindowDefinition)
  windowRegistry.register(feedbackAdminWindowDefinition)
  windowRegistry.register(monitoringWindowDefinition)
  windowRegistry.register(billingRequestsWindowDefinition)
  windowRegistry.register(billingAuditWindowDefinition)
  windowRegistry.register(billingTeamsWindowDefinition)

  // User windows
  windowRegistry.register(providersWindowDefinition)

  // User profile
  windowRegistry.register(profileWindowDefinition)

  // Workspaces
  windowRegistry.register(workspacesListWindowDefinition)
  windowRegistry.register(agentsListWindowDefinition)
  windowRegistry.register(projectsListWindowDefinition)
  windowRegistry.register(workspaceWindowDefinition)

  // Launcher (new tab)
  windowRegistry.register(launcherWindowDefinition)

  // Create agent
  windowRegistry.register(createAgentWindowDefinition)

  // Boards (Kanban)
  windowRegistry.register(boardWindowDefinition)

  // File Viewer (real-time HTML file preview)
  windowRegistry.register(fileViewerWindowDefinition)

  // File Browser (workspace volume directory navigator)
  windowRegistry.register(fileBrowserWindowDefinition)

  // Markdown Viewer (formatted .md / .markdown file reader)
  windowRegistry.register(markdownViewerWindowDefinition)

  // Code Editor (CodeMirror 6 + Vim mode)
  windowRegistry.register(codeEditorWindowDefinition)
  registerCodeEditorHandlers()

  // Terminal (xterm.js in WebView — Fase 1: pseudo-streaming via mca.teros.bash)
  windowRegistry.register(terminalWindowDefinition)

  // Browserbase Live View (cloud browser session viewer)
  windowRegistry.register(browserbaseWindowDefinition)

  // Browser (Plan A: iframe web viewer with toolbar + honest embed fallback)
  windowRegistry.register(browserWindowDefinition)

  // Skills (workspace-level reusable instruction blocks)
  windowRegistry.register(skillsWindowDefinition)

  // Academy (static videotutorial catalog)
  windowRegistry.register(academyWindowDefinition)

  // Automate (trigger × action starters) — gated by automate_v1
  windowRegistry.register(automateWindowDefinition)
  windowRegistry.register(projectWindowDefinition)
  // windowRegistry.register(uiTestWindowDefinition); // disabled — test-only, deployed to prod by mistake

  // Todo List (Workflowy-style hierarchical outliner)
  windowRegistry.register(todoWindowDefinition)
  // To Do task / group detail (opened beside the tree as a preview tab)
  windowRegistry.register(todoNodeWindowDefinition)

  // Flow Editor (React Flow visual workflow builder)
  windowRegistry.register(flowEditorWindowDefinition)

  // Flow Execution Monitor (real-time execution graph + step details)
  windowRegistry.register(flowExecutionWindowDefinition)

  // Flow List (browse and open saved flows)
  windowRegistry.register(flowListWindowDefinition)

  console.log(
    "[WindowTypes] Registered window types:",
    windowRegistry.getAll().map((d) => d.type),
  )
}

export * from "./AgentCoresWindow"
export * from "./AgentWindow"
export * from "./AppsWindow"
export * from "./AppWindow"
export * from "./ArchivedConversationsWindow"
export * from "./CatalogWindow"
// Re-exportar tipos y definiciones
export * from "./ChatWindow"
export * from "./ConsoleWindow"
export * from "./ConversationsWindow"
export * from "./CreateAgentWindow"
export * from "./LauncherWindow"
export * from "./McasWindow"
export * from "./PendingApprovalsWindow"
export * from "./ProfileWindow"
export * from "./ProvidersWindow"
export * from "./AgentUsageWindow"
export * from "./BillingRequestsWindow"
export * from "./BillingAuditWindow"
export * from "./UsersWindow"
export * from "./WorkspacesListWindow"
export * from "./AgentsListWindow"
export * from "./ProjectsListWindow"
export * from "./WorkspacesWindow"
export * from "./BoardWindow"
export * from "./FileViewerWindow"
export * from "./FileBrowserWindow"
export * from "./MarkdownViewerWindow"
export * from "./CodeEditorWindow"
export * from "./TerminalWindow"
export * from "./BrowserbaseWindow"
export * from "./BrowserWindow"
export * from "./SkillsWindow"
export * from "./AcademyWindow"
export * from "./AutomateWindow"
export * from "./ProjectWindow"
export * from "./MonitoringWindow"
export * from "./FeatureFlagsWindow"
export * from "./TerosProviderWindow"
export * from "./FeedbackAdminWindow"
export * from "./LatitudeSignalsWindow"
export * from "./TodoWindow"
export * from "./FlowEditorWindow"
export * from "./FlowExecutionWindow"
export * from "./FlowListWindow"
