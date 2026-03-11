/**
 * Window Types Registry
 *
 * Registers all available window types in the application.
 * Llamar a registerAllWindowTypes() al inicio de la app.
 */

import { windowRegistry } from '../services/windowRegistry';
import { agentCoresWindowDefinition } from './AgentCoresWindow';
import { agentWindowDefinition } from './AgentWindow';
import { boardWindowDefinition } from './BoardWindow';
import { fileViewerWindowDefinition } from './FileViewerWindow';
import { appsWindowDefinition } from './AppsWindow';
import { appWindowDefinition } from './AppWindow';
import { archivedConversationsWindowDefinition } from './ArchivedConversationsWindow';
import { catalogWindowDefinition } from './CatalogWindow';
import { chatWindowDefinition } from './ChatWindow';
import { consoleWindowDefinition } from './ConsoleWindow';
import { conversationsWindowDefinition } from './ConversationsWindow';
import { createAgentWindowDefinition } from './CreateAgentWindow';
import { invitationsWindowDefinition } from './InvitationsWindow/definition';
import { launcherWindowDefinition } from './LauncherWindow';
import { mcasWindowDefinition } from './McasWindow';
import { pendingApprovalsWindowDefinition } from './PendingApprovalsWindow';
import { profileWindowDefinition } from './ProfileWindow';
import { providersWindowDefinition } from './ProvidersWindow';
import { usageWindowDefinition } from './UsageWindow';
import { usersWindowDefinition } from './UsersWindow';
import { voiceWindowDefinition } from './VoiceWindow';
import { workspacesListWindowDefinition } from './WorkspacesListWindow';
import { workspaceWindowDefinition } from './WorkspacesWindow';


/**
 * Registra todos los tipos de ventana
 */
export function registerAllWindowTypes(): void {
  // Chat windows
  windowRegistry.register(chatWindowDefinition);
  windowRegistry.register(voiceWindowDefinition);

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
  windowRegistry.register(appWindowDefinition);

  // Agent configuration
  windowRegistry.register(agentWindowDefinition);

  // Admin windows
  windowRegistry.register(agentCoresWindowDefinition);
  windowRegistry.register(mcasWindowDefinition);
  windowRegistry.register(usersWindowDefinition);
  windowRegistry.register(usageWindowDefinition);

  // User windows
  windowRegistry.register(providersWindowDefinition);

  // User profile
  windowRegistry.register(profileWindowDefinition);

  // Invitations system
  windowRegistry.register(invitationsWindowDefinition);

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
export * from './InvitationsWindow';
export * from './LauncherWindow';
export * from './McasWindow';
export * from './PendingApprovalsWindow';
export * from './ProfileWindow';
export * from './ProvidersWindow';
export * from './UsageWindow';
export * from './UsersWindow';
export * from './VoiceWindow';
export * from './WorkspacesListWindow';
export * from './WorkspacesWindow';
export * from './BoardWindow';
export * from './FileViewerWindow';

