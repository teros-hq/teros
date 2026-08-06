/**
 * Board Commands Handler
 *
 * Handles WebSocket commands for projects, boards, and tasks:
 *
 * Projects: create_project, list_projects, get_project, update_project, delete_project
 * Boards: get_board, get_board_summary, update_board_columns
 * Tasks: create_task, batch_create_tasks, get_task, list_tasks, update_task,
 *        move_task, assign_task, start_task, link_conversation, delete_task,
 *        get_tasks_by_agent, get_task_by_channel
 */

import type { ServerMessage } from '@teros/shared';
import type { WebSocket } from 'ws';
import type { Task } from '../../types/database';
import { type BoardService, type CreateTaskInput, buildTaskInitialMessage } from '../../services/board-service';
import type { ChannelManager } from '../../services/channel-manager';
import type { PubSubService } from '../../services/pubsub-service';
import type { WorkspaceService } from '../../services/workspace-service';
import type { MessageHandler } from '../message-handler';

export interface BoardCommandsDeps {
  boardService: BoardService;
  workspaceService: WorkspaceService;
  channelManager: ChannelManager;
  pubSubService: PubSubService;
  sendMessage: (ws: WebSocket, msg: ServerMessage) => void;
  sendError: (ws: WebSocket, code: string, message: string) => void;
  messageHandler?: MessageHandler;
}

export function createBoardCommands(deps: BoardCommandsDeps) {
  const { boardService, workspaceService, channelManager, pubSubService, sendMessage, sendError, messageHandler } = deps;

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  /**
   * Verify user has access to workspace (is owner or member)
   */
  async function verifyWorkspaceAccess(userId: string, workspaceId: string): Promise<boolean> {
    const role = await workspaceService.getUserRole(workspaceId, userId);
    return role !== null;
  }

  /**
   * Verify user has write access to workspace
   */
  async function verifyWriteAccess(userId: string, workspaceId: string): Promise<boolean> {
    const role = await workspaceService.getUserRole(workspaceId, userId);
    return role === 'owner' || role === 'admin' || role === 'write';
  }

  /**
   * Get workspaceId from projectId (for permission checks)
   */
  async function getWorkspaceFromProject(projectId: string): Promise<string | null> {
    const project = await boardService.getProject(projectId);
    return project?.workspaceId ?? null;
  }

  /**
   * Get workspaceId from boardId
   */
  async function getWorkspaceFromBoard(boardId: string): Promise<string | null> {
    const board = await boardService.getBoard(boardId);
    if (!board) return null;
    const project = await boardService.getProject(board.projectId);
    return project?.workspaceId ?? null;
  }

  /**
   * Get workspaceId from taskId
   */
  async function getWorkspaceFromTask(taskId: string): Promise<string | null> {
    const task = await boardService.getTask(taskId);
    if (!task) return null;
    return getWorkspaceFromBoard(task.boardId);
  }

  // ==========================================================================
  // PROJECT COMMANDS
  // ==========================================================================

  return {
    // ========================================================================
    // PROJECTS
    // ========================================================================

    async handleCreateProject(
      ws: WebSocket,
      userId: string,
      message: { workspaceId: string; name: string; description?: string },
    ): Promise<void> {
      try {
        const { workspaceId, name, description } = message;
        if (!workspaceId || !name) {
          sendError(ws, 'MISSING_FIELDS', 'workspaceId and name are required');
          return;
        }

        if (!(await verifyWriteAccess(userId, workspaceId))) {
          sendError(ws, 'FORBIDDEN', 'No write access to this workspace');
          return;
        }

        const { project, board } = await boardService.createProject(workspaceId, userId, {
          name,
          description,
        });

        sendMessage(ws, {
          type: 'project_created',
          project,
          board,
        } as any);
      } catch (error: any) {
        console.error('❌ Error creating project:', error);
        sendError(ws, 'CREATE_PROJECT_ERROR', error.message || 'Failed to create project');
      }
    },

    async handleListProjects(
      ws: WebSocket,
      userId: string,
      message: { workspaceId: string },
    ): Promise<void> {
      try {
        const { workspaceId } = message;
        if (!workspaceId) {
          sendError(ws, 'MISSING_FIELDS', 'workspaceId is required');
          return;
        }

        if (!(await verifyWorkspaceAccess(userId, workspaceId))) {
          sendError(ws, 'FORBIDDEN', 'No access to this workspace');
          return;
        }

        const projects = await boardService.listProjects(workspaceId);

        sendMessage(ws, {
          type: 'projects_list',
          workspaceId,
          projects,
        } as any);
      } catch (error: any) {
        console.error('❌ Error listing projects:', error);
        sendError(ws, 'LIST_PROJECTS_ERROR', error.message || 'Failed to list projects');
      }
    },

    async handleGetProject(
      ws: WebSocket,
      userId: string,
      message: { projectId: string },
    ): Promise<void> {
      try {
        const { projectId } = message;
        if (!projectId) {
          sendError(ws, 'MISSING_FIELDS', 'projectId is required');
          return;
        }

        const project = await boardService.getProject(projectId);
        if (!project) {
          sendError(ws, 'NOT_FOUND', 'Project not found');
          return;
        }

        if (!(await verifyWorkspaceAccess(userId, project.workspaceId))) {
          sendError(ws, 'FORBIDDEN', 'No access to this workspace');
          return;
        }

        sendMessage(ws, {
          type: 'project_detail',
          project,
        } as any);
      } catch (error: any) {
        console.error('❌ Error getting project:', error);
        sendError(ws, 'GET_PROJECT_ERROR', error.message || 'Failed to get project');
      }
    },

    async handleUpdateProject(
      ws: WebSocket,
      userId: string,
      message: { projectId: string; name?: string; description?: string; context?: string },
    ): Promise<void> {
      try {
        const { projectId, name, description, context } = message;
        if (!projectId) {
          sendError(ws, 'MISSING_FIELDS', 'projectId is required');
          return;
        }

        const wsId = await getWorkspaceFromProject(projectId);
        if (!wsId || !(await verifyWriteAccess(userId, wsId))) {
          sendError(ws, 'FORBIDDEN', 'No write access');
          return;
        }

        const project = await boardService.updateProject(projectId, { name, description, context });
        if (!project) {
          sendError(ws, 'NOT_FOUND', 'Project not found');
          return;
        }

        sendMessage(ws, {
          type: 'project_updated',
          project,
        } as any);
      } catch (error: any) {
        console.error('❌ Error updating project:', error);
        sendError(ws, 'UPDATE_PROJECT_ERROR', error.message || 'Failed to update project');
      }
    },

    async handleDeleteProject(
      ws: WebSocket,
      userId: string,
      message: { projectId: string },
    ): Promise<void> {
      try {
        const { projectId } = message;
        if (!projectId) {
          sendError(ws, 'MISSING_FIELDS', 'projectId is required');
          return;
        }

        const project = await boardService.getProject(projectId);
        if (!project) {
          sendError(ws, 'NOT_FOUND', 'Project not found');
          return;
        }

        // Only admin/owner can delete
        const role = await workspaceService.getUserRole(project.workspaceId, userId);
        if (role !== 'owner' && role !== 'admin') {
          sendError(ws, 'FORBIDDEN', 'Only workspace admin or owner can delete projects');
          return;
        }

        await boardService.deleteProject(projectId);

        sendMessage(ws, {
          type: 'project_deleted',
          projectId,
        } as any);
      } catch (error: any) {
        console.error('❌ Error deleting project:', error);
        sendError(ws, 'DELETE_PROJECT_ERROR', error.message || 'Failed to delete project');
      }
    },

    async handleArchiveProject(
      ws: WebSocket,
      userId: string,
      message: { projectId: string; archiveNote?: string },
    ): Promise<void> {
      try {
        const { projectId, archiveNote } = message;
        if (!projectId) {
          sendError(ws, 'MISSING_FIELDS', 'projectId is required');
          return;
        }

        const project = await boardService.getProject(projectId);
        if (!project) {
          sendError(ws, 'NOT_FOUND', 'Project not found');
          return;
        }

        // Only admin/owner can archive
        const role = await workspaceService.getUserRole(project.workspaceId, userId);
        if (role !== 'owner' && role !== 'admin') {
          sendError(ws, 'FORBIDDEN', 'Only workspace admin or owner can archive projects');
          return;
        }

        const archivedProject = await boardService.archiveProject(projectId, userId, archiveNote);

        sendMessage(ws, {
          type: 'project_archived',
          project: archivedProject,
        } as any);
      } catch (error: any) {
        console.error('❌ Error archiving project:', error);
        sendError(ws, 'ARCHIVE_PROJECT_ERROR', error.message || 'Failed to archive project');
      }
    },

    // ========================================================================
    // BOARDS
    // ========================================================================

    async handleGetBoard(
      ws: WebSocket,
      userId: string,
      message: { projectId: string },
    ): Promise<void> {
      try {
        const { projectId } = message;
        if (!projectId) {
          sendError(ws, 'MISSING_FIELDS', 'projectId is required');
          return;
        }

        const wsId = await getWorkspaceFromProject(projectId);
        if (!wsId || !(await verifyWorkspaceAccess(userId, wsId))) {
          sendError(ws, 'FORBIDDEN', 'No access');
          return;
        }

        const board = await boardService.getBoardByProject(projectId);
        if (!board) {
          sendError(ws, 'NOT_FOUND', 'Board not found');
          return;
        }

        // Get tasks grouped by column
        const tasks = await boardService.listTasks(board.boardId);

        // Resolve agent names/avatars
        const agentIds = boardService.collectAgentIds(tasks);
        const agents = await boardService.resolveAgents(agentIds);

        sendMessage(ws, {
          type: 'board_detail',
          board,
          tasks,
          agents,
        } as any);
      } catch (error: any) {
        console.error('❌ Error getting board:', error);
        sendError(ws, 'GET_BOARD_ERROR', error.message || 'Failed to get board');
      }
    },

    async handleGetBoardSummary(
      ws: WebSocket,
      userId: string,
      message: { projectId: string },
    ): Promise<void> {
      try {
        const { projectId } = message;
        if (!projectId) {
          sendError(ws, 'MISSING_FIELDS', 'projectId is required');
          return;
        }

        const project = await boardService.getProject(projectId);
        if (!project) {
          sendError(ws, 'NOT_FOUND', 'Project not found');
          return;
        }

        if (!(await verifyWorkspaceAccess(userId, project.workspaceId))) {
          sendError(ws, 'FORBIDDEN', 'No access');
          return;
        }

        const summary = await boardService.getBoardSummary(project.boardId);
        if (!summary) {
          sendError(ws, 'NOT_FOUND', 'Board not found');
          return;
        }

        sendMessage(ws, {
          type: 'board_summary',
          projectId,
          ...summary,
        } as any);
      } catch (error: any) {
        console.error('❌ Error getting board summary:', error);
        sendError(ws, 'GET_BOARD_SUMMARY_ERROR', error.message || 'Failed to get board summary');
      }
    },

    async handleUpdateBoardConfig(
      ws: WebSocket,
      userId: string,
      message: { projectId: string; config: any },
    ): Promise<void> {
      try {
        const { projectId, config } = message;
        if (!projectId || !config) {
          sendError(ws, 'MISSING_FIELDS', 'projectId and config are required');
          return;
        }

        const project = await boardService.getProject(projectId);
        if (!project) {
          sendError(ws, 'NOT_FOUND', 'Project not found');
          return;
        }

        if (!(await verifyWriteAccess(userId, project.workspaceId))) {
          sendError(ws, 'FORBIDDEN', 'No write access');
          return;
        }

        const board = await boardService.updateBoardConfig(project.boardId, config);
        if (!board) {
          sendError(ws, 'NOT_FOUND', 'Board not found');
          return;
        }

        sendMessage(ws, {
          type: 'board_config_updated',
          projectId,
          config: board.config,
        } as any);
      } catch (error: any) {
        console.error('❌ Error updating board config:', error);
        sendError(ws, 'UPDATE_BOARD_CONFIG_ERROR', error.message || 'Failed to update board config');
      }
    },

    // ========================================================================
    // TASKS
    // ========================================================================

    async handleCreateTask(
      ws: WebSocket,
      userId: string,
      message: { projectId: string } & CreateTaskInput,
    ): Promise<void> {
      try {
        const { projectId, ...taskInput } = message;
        if (!projectId || !taskInput.title) {
          sendError(ws, 'MISSING_FIELDS', 'projectId and title are required');
          return;
        }

        const project = await boardService.getProject(projectId);
        if (!project) {
          sendError(ws, 'NOT_FOUND', 'Project not found');
          return;
        }

        if (!(await verifyWriteAccess(userId, project.workspaceId))) {
          sendError(ws, 'FORBIDDEN', 'No write access');
          return;
        }

        const task = await boardService.createTask(project.boardId, userId, taskInput);

        sendMessage(ws, {
          type: 'task_created',
          task,
        } as any);
        pubSubService.broadcastToTopic(`board:${project.boardId}`, { type: 'board_task_created', task });
      } catch (error: any) {
        console.error('❌ Error creating task:', error);
        sendError(ws, 'CREATE_TASK_ERROR', error.message || 'Failed to create task');
      }
    },

    async handleBatchCreateTasks(
      ws: WebSocket,
      userId: string,
      message: { projectId: string; tasks: CreateTaskInput[] },
    ): Promise<void> {
      try {
        const { projectId, tasks: taskInputs } = message;
        if (!projectId || !taskInputs || !Array.isArray(taskInputs)) {
          sendError(ws, 'MISSING_FIELDS', 'projectId and tasks array are required');
          return;
        }

        const project = await boardService.getProject(projectId);
        if (!project) {
          sendError(ws, 'NOT_FOUND', 'Project not found');
          return;
        }

        if (!(await verifyWriteAccess(userId, project.workspaceId))) {
          sendError(ws, 'FORBIDDEN', 'No write access');
          return;
        }

        const tasks = await boardService.batchCreateTasks(project.boardId, userId, taskInputs);

        sendMessage(ws, {
          type: 'tasks_batch_created',
          projectId,
          tasks,
          count: tasks.length,
        } as any);
        pubSubService.broadcastToTopic(`board:${project.boardId}`, { type: 'board_tasks_batch_created', tasks });
      } catch (error: any) {
        console.error('❌ Error batch creating tasks:', error);
        sendError(ws, 'BATCH_CREATE_TASKS_ERROR', error.message || 'Failed to batch create tasks');
      }
    },

    async handleGetTask(
      ws: WebSocket,
      userId: string,
      message: { taskId: string },
    ): Promise<void> {
      try {
        const { taskId } = message;
        if (!taskId) {
          sendError(ws, 'MISSING_FIELDS', 'taskId is required');
          return;
        }

        const wsId = await getWorkspaceFromTask(taskId);
        if (!wsId || !(await verifyWorkspaceAccess(userId, wsId))) {
          sendError(ws, 'FORBIDDEN', 'No access');
          return;
        }

        const task = await boardService.getTask(taskId);
        if (!task) {
          sendError(ws, 'NOT_FOUND', 'Task not found');
          return;
        }

        // Get sub-tasks
        const allTasks = await boardService.listTasks(task.boardId, {});
        const subTasks = allTasks.filter((t) => t.parentTaskId === taskId);

        // Resolve agent names/avatars
        const agentIds = boardService.collectAgentIds([task, ...subTasks]);
        const agents = await boardService.resolveAgents(agentIds);

        sendMessage(ws, {
          type: 'task_detail',
          task,
          subTasks,
          agents,
        } as any);
      } catch (error: any) {
        console.error('❌ Error getting task:', error);
        sendError(ws, 'GET_TASK_ERROR', error.message || 'Failed to get task');
      }
    },

    async handleListTasks(
      ws: WebSocket,
      userId: string,
      message: {
        projectId: string;
        columnId?: string;
        assignedAgentId?: string;
        priority?: string;
        tags?: string[];
      },
    ): Promise<void> {
      try {
        const { projectId, ...filters } = message;
        if (!projectId) {
          sendError(ws, 'MISSING_FIELDS', 'projectId is required');
          return;
        }

        const project = await boardService.getProject(projectId);
        if (!project) {
          sendError(ws, 'NOT_FOUND', 'Project not found');
          return;
        }

        if (!(await verifyWorkspaceAccess(userId, project.workspaceId))) {
          sendError(ws, 'FORBIDDEN', 'No access');
          return;
        }

        const tasks = await boardService.listTasks(project.boardId, filters as any);

        // Resolve agent names/avatars
        const agentIds = boardService.collectAgentIds(tasks);
        const agents = await boardService.resolveAgents(agentIds);

        sendMessage(ws, {
          type: 'tasks_list',
          projectId,
          tasks,
          agents,
        } as any);
      } catch (error: any) {
        console.error('❌ Error listing tasks:', error);
        sendError(ws, 'LIST_TASKS_ERROR', error.message || 'Failed to list tasks');
      }
    },

    async handleUpdateTask(
      ws: WebSocket,
      userId: string,
      message: {
        taskId: string;
        title?: string;
        description?: string;
        priority?: string;
        tags?: string[];
        assignedAgentId?: string | null;
      },
    ): Promise<void> {
      try {
        const { taskId, ...updateInput } = message;
        if (!taskId) {
          sendError(ws, 'MISSING_FIELDS', 'taskId is required');
          return;
        }

        const wsId = await getWorkspaceFromTask(taskId);
        if (!wsId || !(await verifyWriteAccess(userId, wsId))) {
          sendError(ws, 'FORBIDDEN', 'No write access');
          return;
        }

        const task = await boardService.updateTask(taskId, userId, updateInput as any);
        if (!task) {
          sendError(ws, 'NOT_FOUND', 'Task not found');
          return;
        }

        sendMessage(ws, {
          type: 'task_updated',
          task,
        } as any);
        pubSubService.broadcastToTopic(`board:${task.boardId}`, { type: 'board_task_updated', task });
      } catch (error: any) {
        console.error('❌ Error updating task:', error);
        sendError(ws, 'UPDATE_TASK_ERROR', error.message || 'Failed to update task');
      }
    },

    async handleMoveTask(
      ws: WebSocket,
      userId: string,
      message: { taskId: string; columnId: string; position?: number },
    ): Promise<void> {
      try {
        const { taskId, columnId, position } = message;
        if (!taskId || !columnId) {
          sendError(ws, 'MISSING_FIELDS', 'taskId and columnId are required');
          return;
        }

        const wsId = await getWorkspaceFromTask(taskId);
        if (!wsId || !(await verifyWriteAccess(userId, wsId))) {
          sendError(ws, 'FORBIDDEN', 'No write access');
          return;
        }

        const task = await boardService.moveTask(taskId, userId, columnId, position);
        if (!task) {
          sendError(ws, 'NOT_FOUND', 'Task not found');
          return;
        }

        sendMessage(ws, {
          type: 'task_moved',
          task,
        } as any);
        pubSubService.broadcastToTopic(`board:${task.boardId}`, { type: 'board_task_updated', task });
      } catch (error: any) {
        console.error('❌ Error moving task:', error);
        sendError(ws, 'MOVE_TASK_ERROR', error.message || 'Failed to move task');
      }
    },

    async handleAssignTask(
      ws: WebSocket,
      userId: string,
      message: { taskId: string; agentId?: string | null },
    ): Promise<void> {
      try {
        const { taskId, agentId } = message;
        if (!taskId) {
          sendError(ws, 'MISSING_FIELDS', 'taskId is required');
          return;
        }

        const wsId = await getWorkspaceFromTask(taskId);
        if (!wsId || !(await verifyWriteAccess(userId, wsId))) {
          sendError(ws, 'FORBIDDEN', 'No write access');
          return;
        }

        const task = await boardService.assignTask(taskId, userId, agentId);
        if (!task) {
          sendError(ws, 'NOT_FOUND', 'Task not found');
          return;
        }

        sendMessage(ws, {
          type: 'task_assigned',
          task,
        } as any);
        pubSubService.broadcastToTopic(`board:${task.boardId}`, { type: 'board_task_updated', task });
      } catch (error: any) {
        console.error('❌ Error assigning task:', error);
        sendError(ws, 'ASSIGN_TASK_ERROR', error.message || 'Failed to assign task');
      }
    },

    async handleStartTask(
      ws: WebSocket,
      userId: string,
      message: { taskId: string; agentId?: string; prompt?: string },
    ): Promise<void> {
      try {
        const { taskId, agentId, prompt } = message;
        if (!taskId) {
          sendError(ws, 'MISSING_FIELDS', 'taskId is required');
          return;
        }

        const wsId = await getWorkspaceFromTask(taskId);
        if (!wsId || !(await verifyWriteAccess(userId, wsId))) {
          sendError(ws, 'FORBIDDEN', 'No write access');
          return;
        }

        // Start task (move to in_progress, assign agent)
        const { task } = await boardService.startTask(taskId, userId, agentId);
        const assignedAgentId = task.assignedAgentId!;

        // Reuse existing conversation or create a new one
        let channel: any;
        if (task.channelId) {
          channel = await channelManager.getChannel(task.channelId);
        }
        if (!channel) {
          channel = await channelManager.createChannel(userId, assignedAgentId, {
            name: task.title,
          }, { workspaceId: wsId });
          await boardService.linkConversation(task.taskId, userId, channel.channelId);
        }

        // Build initial message for the agent
        const initialMessage = buildTaskInitialMessage(task, prompt);

        const startedFullTask = { ...task, channelId: channel.channelId };
        sendMessage(ws, {
          type: 'task_started',
          task: startedFullTask,
          channelId: channel.channelId,
        } as any);
        pubSubService.broadcastToTopic(`board:${task.boardId}`, { type: 'board_task_updated', task: startedFullTask });

        // Send the initial message to trigger the agent (fire-and-forget)
        // We save the message directly and call processAgentResponse instead of
        // handleSendMessage, because the channel has no subscribers yet (user
        // hasn't opened it) and handleSendMessage would fail on broadcast.
        if (messageHandler && channelManager) {
          (async () => {
            try {
              const msgId = channelManager.createMessageId();
              const msgTimestamp = new Date().toISOString();
              const sender = (await channelManager.getUserSender(userId)) || { type: 'user' as const, id: userId, name: 'User' };

              await channelManager.saveMessage({
                messageId: msgId,
                channelId: channel.channelId,
                role: 'user' as const,
                userId,
                sender,
                content: { type: 'text' as const, text: initialMessage },
                timestamp: msgTimestamp,
              });

              await messageHandler.processAgentResponse(
                channel.channelId,
                assignedAgentId,
                initialMessage,
                undefined,
                undefined,
                'autorun',
              );
            } catch (err: any) {
              console.error(`❌ Error sending initial task message to ${channel.channelId}:`, err);
            }
          })();
        }
      } catch (error: any) {
        console.error('❌ Error starting task:', error);
        sendError(ws, 'START_TASK_ERROR', error.message || 'Failed to start task');
      }
    },

    async handleLinkConversation(
      ws: WebSocket,
      userId: string,
      message: { taskId: string; channelId: string },
    ): Promise<void> {
      try {
        const { taskId, channelId } = message;
        if (!taskId || !channelId) {
          sendError(ws, 'MISSING_FIELDS', 'taskId and channelId are required');
          return;
        }

        const wsId = await getWorkspaceFromTask(taskId);
        if (!wsId || !(await verifyWriteAccess(userId, wsId))) {
          sendError(ws, 'FORBIDDEN', 'No write access');
          return;
        }

        const task = await boardService.linkConversation(taskId, userId, channelId);
        if (!task) {
          sendError(ws, 'NOT_FOUND', 'Task not found');
          return;
        }

        sendMessage(ws, {
          type: 'task_conversation_linked',
          task,
        } as any);
        pubSubService.broadcastToTopic(`board:${task.boardId}`, { type: 'board_task_updated', task });
      } catch (error: any) {
        console.error('❌ Error linking conversation:', error);
        sendError(ws, 'LINK_CONVERSATION_ERROR', error.message || 'Failed to link conversation');
      }
    },

    async handleDeleteTask(
      ws: WebSocket,
      userId: string,
      message: { taskId: string },
    ): Promise<void> {
      try {
        const { taskId } = message;
        if (!taskId) {
          sendError(ws, 'MISSING_FIELDS', 'taskId is required');
          return;
        }

        const wsId = await getWorkspaceFromTask(taskId);
        if (!wsId || !(await verifyWriteAccess(userId, wsId))) {
          sendError(ws, 'FORBIDDEN', 'No write access');
          return;
        }

        // Get task before deleting for broadcast
        const taskToDelete = await boardService.getTask(taskId);
        const deleted = await boardService.deleteTask(taskId);
        if (!deleted) {
          sendError(ws, 'NOT_FOUND', 'Task not found');
          return;
        }

        sendMessage(ws, {
          type: 'task_deleted',
          taskId,
        } as any);
        if (taskToDelete) {
          pubSubService.broadcastToTopic(`board:${taskToDelete.boardId}`, {
            type: 'board_task_deleted',
            taskId,
          });
        }
      } catch (error: any) {
        console.error('❌ Error deleting task:', error);
        sendError(ws, 'DELETE_TASK_ERROR', error.message || 'Failed to delete task');
      }
    },

    async handleGetTasksByAgent(
      ws: WebSocket,
      userId: string,
      message: { workspaceId: string; agentId: string; tags?: string[] },
    ): Promise<void> {
      try {
        const { workspaceId, agentId, tags } = message;
        if (!workspaceId || !agentId) {
          sendError(ws, 'MISSING_FIELDS', 'workspaceId and agentId are required');
          return;
        }

        if (!(await verifyWorkspaceAccess(userId, workspaceId))) {
          sendError(ws, 'FORBIDDEN', 'No access');
          return;
        }

        const tasks = await boardService.getTasksByAgent(workspaceId, agentId, tags);

        sendMessage(ws, {
          type: 'agent_tasks_list',
          agentId,
          tasks,
        } as any);
      } catch (error: any) {
        console.error('❌ Error getting tasks by agent:', error);
        sendError(ws, 'GET_TASKS_BY_AGENT_ERROR', error.message || 'Failed to get tasks');
      }
    },

    async handleGetTaskByChannel(
      ws: WebSocket,
      userId: string,
      message: { channelId: string },
    ): Promise<void> {
      try {
        const { channelId } = message;
        if (!channelId) {
          sendError(ws, 'MISSING_FIELDS', 'channelId is required');
          return;
        }

        const task = await boardService.getTaskByChannel(channelId);

        sendMessage(ws, {
          type: 'channel_task',
          channelId,
          task, // null if no task linked
        } as any);
      } catch (error: any) {
        console.error('❌ Error getting task by channel:', error);
        sendError(ws, 'GET_TASK_BY_CHANNEL_ERROR', error.message || 'Failed to get task');
      }
    },

    // ========================================================================
    // RUNNER COMMANDS (ownership-validated)
    // ========================================================================

    async handleMoveMyTask(
      ws: WebSocket,
      userId: string,
      message: { taskId: string; columnId: string; position?: number; agentId: string },
    ): Promise<void> {
      try {
        const { taskId, columnId, position, agentId } = message;
        if (!taskId || !columnId || !agentId) {
          sendError(ws, 'MISSING_FIELDS', 'taskId, columnId, and agentId are required');
          return;
        }

        // Verify task exists and is assigned to this agent
        const task = await boardService.getTask(taskId);
        if (!task) {
          sendError(ws, 'NOT_FOUND', 'Task not found');
          return;
        }

        if (task.assignedAgentId !== agentId) {
          sendError(ws, 'FORBIDDEN', 'You can only move tasks assigned to you');
          return;
        }

        // Verify workspace access
        const wsId = await getWorkspaceFromTask(taskId);
        if (!wsId || !(await verifyWorkspaceAccess(userId, wsId))) {
          sendError(ws, 'FORBIDDEN', 'No access');
          return;
        }

        const updatedTask = await boardService.moveTask(taskId, agentId, columnId, position);
        if (!updatedTask) {
          sendError(ws, 'NOT_FOUND', 'Task not found');
          return;
        }

        sendMessage(ws, {
          type: 'task_moved',
          task: updatedTask,
        } as any);
        pubSubService.broadcastToTopic(`board:${updatedTask.boardId}`, { type: 'board_task_updated', task: updatedTask });
      } catch (error: any) {
        console.error('❌ Error moving own task:', error);
        sendError(ws, 'MOVE_MY_TASK_ERROR', error.message || 'Failed to move task');
      }
    },

    // handleUpdateMyTaskStatus removed — use board.archive-task instead

    async handleAddMyProgressNote(
      ws: WebSocket,
      userId: string,
      message: { taskId: string; text: string; agentId: string },
    ): Promise<void> {
      try {
        const { taskId, text, agentId } = message;
        if (!taskId || !text || !agentId) {
          sendError(ws, 'MISSING_FIELDS', 'taskId, text, and agentId are required');
          return;
        }

        // Verify task exists and is assigned to this agent
        const task = await boardService.getTask(taskId);
        if (!task) {
          sendError(ws, 'NOT_FOUND', 'Task not found');
          return;
        }

        if (task.assignedAgentId !== agentId) {
          sendError(ws, 'FORBIDDEN', 'You can only add progress notes to tasks assigned to you');
          return;
        }

        // Verify workspace access
        const wsId = await getWorkspaceFromTask(taskId);
        if (!wsId || !(await verifyWorkspaceAccess(userId, wsId))) {
          sendError(ws, 'FORBIDDEN', 'No access');
          return;
        }

        const updatedTask = await boardService.addProgressNote(taskId, text, agentId);
        if (!updatedTask) {
          sendError(ws, 'NOT_FOUND', 'Task not found');
          return;
        }

        sendMessage(ws, {
          type: 'task_progress_note_added',
          task: updatedTask,
        } as any);
        pubSubService.broadcastToTopic(`board:${updatedTask.boardId}`, { type: 'board_task_updated', task: updatedTask });
      } catch (error: any) {
        console.error('❌ Error adding progress note:', error);
        sendError(ws, 'ADD_MY_PROGRESS_NOTE_ERROR', error.message || 'Failed to add progress note');
      }
    },

    // ========================================================================
    // MANAGER COMMANDS
    // ========================================================================

    async handleArchiveTask(
      ws: WebSocket,
      userId: string,
      message: { taskId: string; archived: boolean; archiveNote?: string; actor?: string },
    ): Promise<void> {
      try {
        const { taskId, archived, archiveNote, actor } = message;
        if (!taskId || archived === undefined) {
          sendError(ws, 'MISSING_FIELDS', 'taskId and archived are required');
          return;
        }

        const wsId = await getWorkspaceFromTask(taskId);
        if (!wsId || !(await verifyWriteAccess(userId, wsId))) {
          sendError(ws, 'FORBIDDEN', 'No write access');
          return;
        }

        const result = archived
          ? await boardService.archiveTask(taskId, actor || userId, archiveNote)
          : await boardService.unarchiveTask(taskId, actor || userId);
        if (!result) {
          sendError(ws, 'NOT_FOUND', 'Task not found');
          return;
        }

        sendMessage(ws, { type: 'task_archived', task: result } as any);
        pubSubService.broadcastToTopic(`board:${result.boardId}`, { type: 'board_task_updated', task: result });
      } catch (error: any) {
        console.error('❌ Error archiving task:', error);
        sendError(ws, 'ARCHIVE_TASK_ERROR', error.message || 'Failed to archive task');
      }
    },

    async handleAddProgressNote(
      ws: WebSocket,
      userId: string,
      message: { taskId: string; text: string; actor: string },
    ): Promise<void> {
      try {
        const { taskId, text, actor } = message;
        if (!taskId || !text) {
          sendError(ws, 'MISSING_FIELDS', 'taskId and text are required');
          return;
        }

        const wsId = await getWorkspaceFromTask(taskId);
        if (!wsId || !(await verifyWriteAccess(userId, wsId))) {
          sendError(ws, 'FORBIDDEN', 'No write access');
          return;
        }

        const task = await boardService.addProgressNote(taskId, text, actor || userId);
        if (!task) {
          sendError(ws, 'NOT_FOUND', 'Task not found');
          return;
        }

        sendMessage(ws, {
          type: 'task_progress_note_added',
          task,
        } as any);
        pubSubService.broadcastToTopic(`board:${task.boardId}`, { type: 'board_task_updated', task });
      } catch (error: any) {
        console.error('❌ Error adding progress note:', error);
        sendError(ws, 'ADD_PROGRESS_NOTE_ERROR', error.message || 'Failed to add progress note');
      }
    },
  };
}
