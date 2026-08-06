/**
 * Window Types Registry
 *
 * Registers all available window types in the application.
 * Llamar a registerAllWindowTypes() al inicio de la app.
 */

import { windowRegistry } from '../services/windowRegistry';
import { codeEditorWindowDefinition } from './CodeEditorWindow';
import { registerCodeEditorHandlers } from './CodeEditorWindow/registerHandlers';
import { terminalWindowDefinition } from './TerminalWindow';
import { agentCoresWindowDefinition } from './AgentCoresWindow';
import { agentWindowDefinition } from './AgentWindow';
import { boardWindowDefinition } from './BoardWindow';
import { fileViewerWindowDefinition } from './FileViewerWindow';
import { fileBrowserWindowDefinition } from './FileBrowserWindow';
import { markdownViewerWindowDefinition } from './MarkdownViewerWindow';
import { browserbaseWindowDefinition } from './BrowserbaseWindow';
import { skillsWindowDefinition } from './SkillsWindow';
import { projectWindowDefinition } from './ProjectWindow';
// import { uiTestWindowDefinition } from './UITestWindow/definition';
import { appsWindowDefinition } from './AppsWindow';
import { appWindowDefinition } from './AppWindow';
import { archivedConversationsWindowDefinition } from './ArchivedConversationsWindow';
import { catalogWindowDefinition } from './CatalogWindow';
import { catalogDetailWindowDefinition } from './CatalogDetailWindow';
import { chatWindowDefinition } from './ChatWindow';
import { consoleWindowDefinition } from './ConsoleWindow';
import { conversationsWindowDefinition } from './ConversationsWindow';
import { createAgentWindowDefinition } from './CreateAgentWindow';
import { launcherWindowDefinition } from './LauncherWindow';
import { mcasWindowDefinition } from './McasWindow';
import { pendingApprovalsWindowDefinition } from './PendingApprovalsWindow';
import { profileWindowDefinition } from './ProfileWindow';
import { providersWindowDefinition } from './ProvidersWindow';
import { agentUsageWindowDefinition } from './AgentUsageWindow';
import { modelHealthWindowDefinition } from './ModelHealthWindow';
import { sessionTraceWindowDefinition } from './SessionTraceWindow';
import { latitudeSignalsWindowDefinition } from './LatitudeSignalsWindow';
import { billingRequestsWindowDefinition } from './BillingRequestsWindow';
import { billingAuditWindowDefinition } from './BillingAuditWindow';
import { billingTeamsWindowDefinition } from './BillingTeamsWindow';
import { usersWindowDefinition } from './UsersWindow';
import { workspacesListWindowDefinition } from './WorkspacesListWindow';
import { workspaceWindowDefinition } from './WorkspacesWindow';
import { featureFlagsWindowDefinition } from './FeatureFlagsWindow';
import { monitoringWindowDefinition } from './MonitoringWindow';


/**
 * Registra todos los tipos de ventana
 */
export function registerAllWindowTypes(): void {
  // Chat windows
  windowRegistry.register(chatWindowDefinition);

  // Conversations list
  windowRegistry.register(conversationsWindowDefinition);
  windowRegistry.register(archivedConversationsWindowDefinition);

  // Pending approvals
  windowRegistry.register(pendingApprovalsWindowDefinition);

  // Dev tools
  windowRegistry.register(consoleWindowDefinition);

  // Apps management
  windowRegistry.register(appsWindowDefinition);
  windowRegistry.register(catalogWindowDefinition);
  windowRegistry.register(catalogDetailWindowDefinition);
  windowRegistry.register(appWindowDefinition);

  // Agent configuration
  windowRegistry.register(agentWindowDefinition);

  // Admin windows
  windowRegistry.register(agentCoresWindowDefinition);
  windowRegistry.register(mcasWindowDefinition);
  windowRegistry.register(usersWindowDefinition);
  windowRegistry.register(agentUsageWindowDefinition);
  windowRegistry.register(modelHealthWindowDefinition);
  windowRegistry.register(sessionTraceWindowDefinition);
  windowRegistry.register(latitudeSignalsWindowDefinition);
  windowRegistry.register(featureFlagsWindowDefinition);
  windowRegistry.register(monitoringWindowDefinition);
  windowRegistry.register(billingRequestsWindowDefinition);
  windowRegistry.register(billingAuditWindowDefinition);
  windowRegistry.register(billingTeamsWindowDefinition);

  // User windows
  windowRegistry.register(providersWindowDefinition);

  // User profile
  windowRegistry.register(profileWindowDefinition);

  // Workspaces
  windowRegistry.register(workspacesListWindowDefinition);
  windowRegistry.register(workspaceWindowDefinition);

  // Launcher (new tab)
  windowRegistry.register(launcherWindowDefinition);

  // Create agent
  windowRegistry.register(createAgentWindowDefinition);

  // Boards (Kanban)
  windowRegistry.register(boardWindowDefinition);

  // File Viewer (real-time HTML file preview)
  windowRegistry.register(fileViewerWindowDefinition);

  // File Browser (workspace volume directory navigator)
  windowRegistry.register(fileBrowserWindowDefinition);

  // Markdown Viewer (formatted .md / .markdown file reader)
  windowRegistry.register(markdownViewerWindowDefinition);

  // Code Editor (CodeMirror 6 + Vim mode)
  windowRegistry.register(codeEditorWindowDefinition);
  registerCodeEditorHandlers();

  // Terminal (xterm.js in WebView — Fase 1: pseudo-streaming via mca.teros.bash)
  windowRegistry.register(terminalWindowDefinition);

  // Browserbase Live View (cloud browser session viewer)
  windowRegistry.register(browserbaseWindowDefinition);

  // Skills (workspace-level reusable instruction blocks)
  windowRegistry.register(skillsWindowDefinition);
  windowRegistry.register(projectWindowDefinition);
  // windowRegistry.register(uiTestWindowDefinition); // disabled — test-only, deployed to prod by mistake

  console.log(
    '[WindowTypes] Registered window types:',
    windowRegistry.getAll().map((d) => d.type),
  );
}

export * from './AgentCoresWindow';
export * from './AgentWindow';
export * from './AppsWindow';
export * from './AppWindow';
export * from './ArchivedConversationsWindow';
export * from './CatalogWindow';
// Re-exportar tipos y definiciones
export * from './ChatWindow';
export * from './ConsoleWindow';
export * from './ConversationsWindow';
export * from './CreateAgentWindow';
export * from './LauncherWindow';
export * from './McasWindow';
export * from './PendingApprovalsWindow';
export * from './ProfileWindow';
export * from './ProvidersWindow';
export * from './AgentUsageWindow';
export * from './BillingRequestsWindow';
export * from './BillingAuditWindow';
export * from './UsersWindow';
export * from './WorkspacesListWindow';
export * from './WorkspacesWindow';
export * from './BoardWindow';
export * from './FileViewerWindow';
export * from './FileBrowserWindow';
export * from './MarkdownViewerWindow';
export * from './CodeEditorWindow';
export * from './TerminalWindow';
export * from './BrowserbaseWindow';
export * from './SkillsWindow';
export * from './ProjectWindow';
export * from './MonitoringWindow';
export * from './FeatureFlagsWindow';
export * from './LatitudeSignalsWindow';

