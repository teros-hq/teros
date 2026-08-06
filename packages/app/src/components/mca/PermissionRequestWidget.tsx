/**
 * Permission Request Widget
 *
 * Displays the permission request UI matching the approved design from

 *
 * Design features:
 * - Two-section layout: Context Preview + Controls
 * - Risk level indicator (High/Medium/Low)
 * - Natural language description of the action
 * - Key parameters preview as badges
 * - Expandable details section
 * - Purple accent color (semanticColors.violet)
 */

import {
  AlertTriangle,
  Check,
  ChevronDown,
  MoreVertical,
  Shield,
  ShieldCheck,
  ShieldOff,
  X,
} from '@tamagui/lucide-icons';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Modal, Platform, Pressable, ScrollView, TouchableOpacity, View } from 'react-native';
import { Text, XStack, YStack } from 'tamagui';
import { useTranslation } from 'react-i18next';
import { usePermissionCallbacks } from './types';
import { colors as semanticColors, controlsBar as controlsBarTokens, indicators, surface } from './primitives/colors';
import { useColors } from './primitives/useColors';

// ============================================================================
// Types
// ============================================================================

export type RiskLevel = 'high' | 'medium' | 'low';

interface PermissionRequestWidgetProps {
  permissionRequestId: string;
  appId?: string;
  toolName: string;
  input?: Record<string, any>;
}

// ============================================================================
// Risk Level Detection
// ============================================================================

/**
 * Determine risk level based on tool name and input parameters
 */
function getRiskLevel(toolName: string, input?: Record<string, any>): RiskLevel {
  const tool = toolName.toLowerCase();
  const inputStr = JSON.stringify(input || {}).toLowerCase();

  // High risk patterns (destructive or hard-to-reverse)
  const highRiskPatterns = [
    'delete',
    'remove',
    'rm -rf',
    'drop',
    'truncate',
    'destroy',
    'purge',
    'recursive',
    'uninstall',
    'archive',
    'revoke',
  ];

  // Medium risk patterns
  const mediumRiskPatterns = [
    'write',
    'update',
    'modify',
    'edit',
    'move',
    'rename',
    'chmod',
    'chown',
  ];

  // Check for high risk
  if (highRiskPatterns.some((pattern) => tool.includes(pattern) || inputStr.includes(pattern))) {
    return 'high';
  }

  // Check for medium risk
  if (mediumRiskPatterns.some((pattern) => tool.includes(pattern) || inputStr.includes(pattern))) {
    return 'medium';
  }

  // Default to low risk
  return 'low';
}

/** Truncate long IDs to a head…tail form (e.g. 'task_401e26aea…fefe'). */
function shortId(id: unknown): string {
  if (typeof id !== 'string' || !id) return '?';
  if (id.length <= 20) return id;
  return `${id.slice(0, 14)}…${id.slice(-4)}`;
}

/** HTML-escape user-controlled content before interpolating into strings
 * that are rendered with dangerouslySetInnerHTML. */
function esc(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const DANGER = `<strong style="color:${semanticColors.red}">`;
const WARN = `<strong style="color:${semanticColors.amber}">`;

// --- Board MCAs (manager + runner) ----------------------------------------
// Descriptions for tools in mca.teros.board-manager and mca.teros.board-runner.
// Even read-only tools get a description — without it the widget shows the
// literal "Wants to execute tool: board-manager_list-tasks" fallback.
function describeBoardTool(short: string, input?: Record<string, any>): string | null {
  // Reads
  if (short === 'list-tasks') {
    return `Wants to list tasks in project <code>${shortId(input?.projectId)}</code>.`;
  }
  if (short === 'list-projects') {
    const ws = input?.workspaceId
      ? ` in workspace <code>${shortId(input.workspaceId)}</code>`
      : ' in the current workspace';
    return `Wants to list projects${ws}.`;
  }
  if (short === 'get-project') {
    return `Wants to read project <code>${shortId(input?.projectId)}</code> (metadata + board columns).`;
  }
  if (short === 'get-task') {
    return `Wants to read task <code>${shortId(input?.taskId)}</code> (detail + sub-tasks).`;
  }
  if (short === 'list-board-agents') {
    return `Wants to list agents with access to the Board MCAs in the workspace.`;
  }
  if (short === 'get-task-dependencies') {
    return `Wants to list dependencies of task <code>${shortId(input?.taskId)}</code>.`;
  }
  if (short === 'get-board-status') {
    return `Wants to read operational status of board <code>${shortId(input?.boardId)}</code> (workload + blockers).`;
  }
  if (short === 'list-board-subscriptions') {
    return `Wants to list active board subscriptions for this conversation.`;
  }
  if (short === 'get-my-tasks') {
    return `Wants to list tasks assigned to this agent.`;
  }
  if (short === 'get-my-task') {
    return `Wants to read the task linked to this conversation.`;
  }

  // Creates
  if (short === 'create-project') {
    const name = esc(input?.name ?? 'a new project');
    return `Will create project <strong>${name}</strong> (including its Kanban board with default columns).`;
  }
  if (short === 'create-task') {
    const title = esc(input?.title ?? 'a new task');
    return `Will create task <strong>${title}</strong> in project <code>${shortId(input?.projectId)}</code>.`;
  }
  if (short === 'batch-create-tasks') {
    const n = Array.isArray(input?.tasks) ? input.tasks.length : 0;
    const tag = n > 10 ? DANGER : '<strong>';
    return `Will create ${tag}${n} tasks</strong> at once in project <code>${shortId(input?.projectId)}</code>.`;
  }

  // Updates
  if (short === 'update-task') {
    const id = shortId(input?.taskId);
    const changes: string[] = [];
    if (input?.title) changes.push(`title → <strong>${esc(input.title)}</strong>`);
    if (input?.priority) changes.push(`priority → <strong>${esc(input.priority)}</strong>`);
    if (input?.description) changes.push('new description');
    if (input?.tags) changes.push('updated tags');
    return `Will update task <code>${id}</code>:<br>${changes.length ? changes.join(', ') : '(no visible changes)'}.`;
  }
  if (short === 'update-project') {
    const id = shortId(input?.projectId);
    const changes: string[] = [];
    if (input?.name) changes.push(`name → <strong>${esc(input.name)}</strong>`);
    if (input?.description) changes.push('new description');
    if (input?.context !== undefined) changes.push('updated context (injected in system prompts)');
    return `Will update project <code>${id}</code>:<br>${changes.length ? changes.join(', ') : '(no visible changes)'}.`;
  }
  if (short === 'assign-task') {
    const task = shortId(input?.taskId);
    if (!input?.agentId) {
      return `Will ${WARN}unassign</strong> agent from task <code>${task}</code>.`;
    }
    const agent = shortId(input.agentId);
    return `Will assign task <code>${task}</code> to agent <code>${agent}</code>.`;
  }

  // State transitions
  if (short === 'move-task' || short === 'move-my-task') {
    const col = input?.columnSlug ?? input?.columnId ?? '?';
    return `Wants to move task <code>${shortId(input?.taskId)}</code> to column <code>${esc(col)}</code>.`;
  }
  if (short === 'start-task') {
    return `Will start task <code>${shortId(input?.taskId)}</code> and create a dedicated conversation with the assigned agent.`;
  }
  if (short === 'stop-task') {
    return `Will ${WARN}send a cooperative stop signal</strong> to running task <code>${shortId(input?.taskId)}</code>. The agent finishes the current step and moves the task to Blocked.`;
  }
  if (short === 'archive-task') {
    const t = shortId(input?.taskId);
    if (input?.archived === true) {
      return `Will ${WARN}archive</strong> task <code>${t}</code> (out of the active board).`;
    }
    return `Will restore task <code>${t}</code> to the active board.`;
  }
  if (short === 'delete-task') {
    return `Will ${DANGER}permanently delete</strong> task <code>${shortId(input?.taskId)}</code>. <strong style="color:${semanticColors.red}">Irreversible</strong>. Sub-tasks become top-level tasks.`;
  }
  if (short === 'link-conversation') {
    return `Will link conversation <code>${shortId(input?.channelId)}</code> to task <code>${shortId(input?.taskId)}</code>.`;
  }
  if (short === 'complete-my-task') {
    return `Will mark task <code>${shortId(input?.taskId)}</code> as complete and move it to Review.`;
  }
  if (short === 'block-my-task') {
    const reason = input?.reason ? `<br>Reason: ${esc(String(input.reason).slice(0, 160))}` : '';
    return `Will ${WARN}block</strong> task <code>${shortId(input?.taskId)}</code>${reason}`;
  }
  if (short === 'cancel-my-task') {
    const reason = input?.reason ? `<br>Reason: ${esc(String(input.reason).slice(0, 160))}` : '';
    return `Will ${WARN}cancel</strong> task <code>${shortId(input?.taskId)}</code> (archives in place)${reason}`;
  }

  // Dependencies
  if (short === 'add-task-dependency') {
    return `Will make task <code>${shortId(input?.taskId)}</code> depend on <code>${shortId(input?.dependsOnTaskId)}</code>. Cycle detection runs automatically.`;
  }
  if (short === 'remove-task-dependency') {
    return `Will remove the dependency: task <code>${shortId(input?.taskId)}</code> no longer depends on <code>${shortId(input?.dependsOnTaskId)}</code>.`;
  }

  // Progress notes
  if (short === 'add-progress-note') {
    const preview = input?.text ? `<br>Note: ${esc(String(input.text).slice(0, 160))}` : '';
    return `Will add a progress note to task <code>${shortId(input?.taskId)}</code>.${preview}`;
  }

  // Autoplay
  if (short === 'set-agent-slots') {
    const slots = input?.slots ?? 0;
    const verb = slots === 0 ? `${WARN}disable autoplay (slots=0)</strong>` : `set <strong>${slots} slots</strong>`;
    return `Will ${verb} for agent <code>${shortId(input?.agentId)}</code> on project <code>${shortId(input?.projectId)}</code>.`;
  }
  if (short === 'set-agent-play') {
    const verb = input?.enabled === true ? `<strong>enable autoplay ▶</strong>` : `${WARN}disable autoplay ⏸</strong>`;
    return `Will ${verb} for agent <code>${shortId(input?.agentId)}</code> on project <code>${shortId(input?.projectId)}</code>.`;
  }

  // Subscriptions
  if (short === 'subscribe-to-board') {
    return `Will subscribe this conversation to real-time events from board <code>${shortId(input?.boardId)}</code>.`;
  }
  if (short === 'unsubscribe-from-board') {
    return `Will unsubscribe this conversation from board <code>${shortId(input?.boardId)}</code>.`;
  }

  return null;
}

/**
 * Generate natural language description of what the tool will do
 */
function getActionDescription(toolName: string, input?: Record<string, any>): string {
  const tool = toolName.toLowerCase();
  const short = tool.split('_').pop() ?? tool;

  // Board MCAs — match first since the prefixes (board-manager_, board-runner_)
  // collide with generic keyword matches below.
  if (tool.includes('board-manager') || tool.includes('board-runner')) {
    const board = describeBoardTool(short, input);
    if (board) return board;
  }

  // Conversations — import a chat attachment into the workspace volume.
  if (short === 'import-attachment' || tool.includes('import-attachment')) {
    const filename = input?.filename ? esc(String(input.filename)) : 'a chat attachment';
    const dest = input?.destPath ? ` to <code>${esc(String(input.destPath))}</code>` : '';
    return `Wants to import <strong>${filename}</strong> into the workspace${dest}.`;
  }

  // Bash/Shell commands
  if (tool.includes('bash') || tool.includes('shell') || tool.includes('exec')) {
    const cmd = input?.command || input?.cmd;
    if (cmd) {
      if (cmd.includes('rm -rf')) {
        return `Wants to delete all files recursively in the current directory. This action is <strong style="color:${semanticColors.red}">irreversible</strong>.`;
      }
      if (cmd.includes('rm ')) {
        return `Wants to delete files using: <code>${cmd}</code>`;
      }
      return `Wants to execute shell command: <code>${cmd}</code>`;
    }
    return 'Wants to execute a shell command on your system.';
  }

  // --- Google Drive (mca.google.drive) ---
  // GUARDED by MCA: short names like list-files / get-file / upload-file /
  // create-folder COLLIDE with other MCAs (Slack, GitHub, Figma, ClickUp, Outlook,
  // Canva), so apply these descriptions only when the tool belongs to the Drive app.
  // toolName is `${appName}_${short}`; the default app name contains "drive". If
  // renamed, the tool falls through to the generic fallback (correct, not
  // mis-attributed). Placed before the filesystem branch below (which greedily
  // matches any tool containing 'file').
  if (tool.toLowerCase().includes('drive')) {
    const fid = () => (input?.fileId ? ` <code>${esc(shortId(input.fileId))}</code>` : '');
    const DRIVE: Record<string, () => string> = {
      'create-document': () =>
        `Wants to create a native Google Doc <strong>${input?.title ? esc(truncate(String(input.title), 40)) : 'a new document'}</strong> in Google Drive.`,
      'list-files': () => 'Wants to list files in Google Drive.',
      'search-files': () =>
        `Wants to search Google Drive${input?.searchTerm ? ` for "${esc(truncate(String(input.searchTerm), 40))}"` : ''}.`,
      'get-file': () => `Wants to read file metadata${fid()} in Google Drive.`,
      'get-file-content': () => `Wants to read the contents of a Google Drive file${fid()}.`,
      'download-file': () => `Wants to download a file${fid()} from Google Drive.`,
      'create-folder': () =>
        `Will create folder <strong>${input?.name ? esc(truncate(String(input.name), 40)) : 'a folder'}</strong> in Google Drive.`,
      'move-file': () => `Will ${WARN}move</strong> a Google Drive file${fid()}.`,
      'copy-file': () => `Will copy a Google Drive file${fid()}.`,
      'delete-file': () => `Will ${DANGER}delete</strong> a Google Drive file${fid()}.`,
      'share-file': () =>
        `Will ${WARN}share</strong> a Google Drive file${fid()}${input?.emailAddress ? ` with <strong>${esc(String(input.emailAddress))}</strong>` : ''}.`,
      'read-document': () => `Wants to read a Google Doc${fid()}.`,
      'read-spreadsheet': () => `Wants to read a Google Sheet${fid()}.`,
      'read-presentation': () => `Wants to read a Google Slides presentation${fid()}.`,
      'read-slide': () => 'Wants to read a slide of a Google Slides presentation.',
      'read-sheet-range': () => 'Wants to read a cell range from a Google Sheet.',
      'list-sheet-tabs': () => 'Wants to list the tabs of a Google Sheet.',
      'export-sheet': () =>
        `Will export a Google Sheet${input?.format ? ` to ${esc(String(input.format))}` : ''}.`,
      'update-document': () =>
        `Will ${WARN}replace text</strong> in a Google Doc${input?.documentId ? ` <code>${esc(shortId(input.documentId))}</code>` : ''}.`,
      'insert-text': () => `Will ${WARN}insert text</strong> into a Google Doc.`,
      'append-text': () => `Will ${WARN}append text</strong> to a Google Doc.`,
      'batch-update-document': () => `Will ${WARN}apply batch edits</strong> to a Google Doc.`,
    };

    if (short === 'upload-file' && typeof input?.filePath === 'string') {
      const fileName = esc(String(input.filePath).split('/').pop() || 'a file');
      const convertTo = input?.convertTo
        ? ` and convert it to a Google ${esc(String(input.convertTo))}`
        : '';
      return `Wants to upload <strong>${fileName}</strong> to Google Drive${convertTo}.`;
    }
    const driveFn = DRIVE[short];
    if (driveFn) return driveFn();

    // Comment/reply short names are shared with Notion — only Drive passes a fileId.
    if (input?.fileId) {
      if (short === 'create-comment') return `Will add a comment to a Google Drive file${fid()}.`;
      if (short === 'list-comments')
        return `Wants to list comments on a Google Drive file${fid()}.`;
      if (short === 'get-comment') return `Wants to read a comment on a Google Drive file${fid()}.`;
      if (short === 'update-comment')
        return `Will ${WARN}edit</strong> a comment on a Google Drive file${fid()}.`;
      if (short === 'delete-comment')
        return `Will ${DANGER}delete</strong> a comment on a Google Drive file${fid()}.`;
      if (short === 'create-reply') return `Will reply to a comment on a Google Drive file${fid()}.`;
      if (short === 'list-replies')
        return `Wants to list replies on a Google Drive file${fid()}.`;
    }
  }

  // Filesystem operations (mca.teros.filesystem + mca.teros.admin.filesystem)
  if (tool.includes('filesystem') || tool.includes('file')) {
    const path = input?.path || input?.filePath;
    const source = input?.source;
    const destination = input?.destination;
    const pattern = input?.pattern;

    // Auditing
    if (tool.endsWith('_list-roots') || tool.endsWith('-list-roots') || tool === 'list-roots') {
      return 'Wants to list workspace roots you can access.';
    }

    // Hash & integrity
    if (tool.endsWith('_hash') || tool === 'hash') {
      const algorithm = input?.algorithm || 'sha256';
      return `Wants to compute the ${algorithm} hash${path ? ` of: <code>${path}</code>` : ' of a file'}.`;
    }

    // Read family (batch reads N files in one call)
    if (tool.endsWith('_read-batch') || tool.endsWith('-read-batch') || tool === 'read-batch') {
      const paths = Array.isArray(input?.paths) ? input.paths : [];
      return `Wants to read ${paths.length} files in a single batch.`;
    }
    if (tool.endsWith('_read-media') || tool.endsWith('-read-media') || tool === 'read-media') {
      return `Wants to read a media file (image, PDF, audio, ...)${path ? ` from: <code>${path}</code>` : ''}.`;
    }
    if (tool.includes('read')) {
      return `Wants to read file contents${path ? ` from: <code>${path}</code>` : ''}.`;
    }

    // Write family
    if (tool.includes('append')) {
      return `Wants to append content to a file${path ? `: <code>${path}</code>` : ''}.`;
    }
    if (tool.includes('patch')) {
      return `Wants to apply a unified diff patch to a file${path ? `: <code>${path}</code>` : ''}.`;
    }
    if (tool.includes('write')) {
      return `Wants to write or modify a file${path ? `: <code>${path}</code>` : ''}.`;
    }
    if (tool.includes('edit')) {
      return `Wants to edit a file in place${path ? `: <code>${path}</code>` : ''} (exact string replacement).`;
    }

    // Navigation
    if (tool.endsWith('_list') || tool === 'list') {
      return `Wants to list directory contents${path ? ` at: <code>${path}</code>` : ''}.`;
    }
    if (tool.endsWith('_tree') || tool === 'tree') {
      return `Wants to get a recursive tree view${path ? ` of: <code>${path}</code>` : ''}.`;
    }
    if (tool.endsWith('_stat') || tool === 'stat') {
      return `Wants to read metadata (size, mtime, type) of${path ? `: <code>${path}</code>` : ' a path'}.`;
    }

    // Search
    if (tool.endsWith('_glob') || tool === 'glob') {
      return `Wants to find files by pattern${pattern ? `: <code>${pattern}</code>` : ''}.`;
    }
    if (tool.endsWith('_grep') || tool === 'grep') {
      return `Wants to search file contents for pattern${pattern ? `: <code>${pattern}</code>` : ''}.`;
    }

    // Mutations
    if (tool.includes('delete') || tool.includes('remove')) {
      return `Wants to permanently delete a path${path ? `: <code>${path}</code>` : ''}. This action is <strong style="color:${semanticColors.red}">irreversible</strong>.`;
    }
    if (tool.includes('copy')) {
      return `Wants to copy${source ? ` <code>${source}</code>` : ''}${destination ? ` to <code>${destination}</code>` : ''}.`;
    }
    if (tool.includes('move')) {
      return `Wants to move or rename${source ? ` <code>${source}</code>` : ''}${destination ? ` to <code>${destination}</code>` : ''}.`;
    }
    if (tool.includes('mkdir')) {
      return `Wants to create a directory${path ? `: <code>${path}</code>` : ''}.`;
    }
  }

  // Email operations
  if (tool.includes('mail') || tool.includes('email')) {
    if (tool.includes('send')) {
      const to = input?.to || input?.recipient;
      return `Wants to send an email${to ? ` to: <strong>${to}</strong>` : ''}.`;
    }
    if (tool.includes('delete')) {
      return 'Wants to delete email messages.';
    }
  }

  // Calendar operations
  if (tool.includes('calendar')) {
    if (tool.includes('create') || tool.includes('add')) {
      const title = input?.title || input?.summary;
      return `Wants to create a new calendar event${title ? `: <strong>${title}</strong>` : ''} on your primary calendar.`;
    }
  }

  // ==========================================================================
  // SCHEDULER (mca.teros.scheduler) — TER-358
  // Reminders y recurring tasks scoped al user. Las destructive tools llevan
  // wording explícito; las read-only describen el filtro aplicado.
  // ==========================================================================
  if (tool.includes('scheduler') || tool.endsWith('schedule-reminder') || tool.endsWith('create-recurring-task')) {
    const reminderId = input?.reminderId;
    const taskId = input?.taskId;
    const message = input?.message;
    const time = input?.time;
    const delay = input?.delay;
    const cron = input?.cronExpression;
    const channelId = input?.channelId;
    const channelTag = channelId ? ` in channel <code>${esc(String(channelId).slice(0, 24))}</code>` : '';

    // Read-only
    if (tool.endsWith('list-reminders') || tool.endsWith('_list-reminders')) {
      return `Wants to list your reminders${channelTag}.`;
    }
    if (tool.endsWith('list-recurring-tasks') || tool.endsWith('_list-recurring-tasks')) {
      return `Wants to list your recurring tasks${channelTag}.`;
    }
    if (tool.endsWith('list-upcoming') || tool.endsWith('_list-upcoming')) {
      const days = input?.days ?? 7;
      return `Wants to list your upcoming reminders and recurring tasks in the next <strong>${days}</strong> day(s)${channelTag}.`;
    }
    if (tool.endsWith('list-executions') || tool.endsWith('_list-executions')) {
      return `Wants to list the execution history of recurring task <code>${esc(String(taskId ?? '?'))}</code>.`;
    }
    if (tool.endsWith('get-reminder') || tool.endsWith('_get-reminder')) {
      return `Wants to read reminder <code>${esc(String(reminderId ?? '?'))}</code>.`;
    }
    if (tool.endsWith('get-recurring-task') || tool.endsWith('_get-recurring-task')) {
      return `Wants to read recurring task <code>${esc(String(taskId ?? '?'))}</code>.`;
    }
    if (tool.endsWith('get-stats') || tool.endsWith('_get-stats')) {
      return 'Wants to read your scheduler stats (active reminders, recurring tasks, next run).';
    }
    if (tool.endsWith('parse-time-expression') || tool.endsWith('_parse-time-expression')) {
      return `Wants to preview parsing the expression <code>${esc(String(input?.expression ?? '?').slice(0, 60))}</code> (no scheduling).`;
    }
    if (tool.endsWith('-health-check') || tool.endsWith('health-check')) {
      return 'Wants to run an internal scheduler health check (MongoDB connectivity).';
    }

    // Creates
    if (tool.endsWith('schedule-reminder') || tool.endsWith('_schedule-reminder')) {
      const whenTag = time ? ` at <strong>${esc(String(time).slice(0, 40))}</strong>` : '';
      const msgTag = message ? ` saying "${esc(String(message).slice(0, 60))}"` : '';
      return `Wants to schedule a one-shot reminder${whenTag}${channelTag}${msgTag}.`;
    }
    if (tool.endsWith('create-recurring-task') || tool.endsWith('_create-recurring-task')) {
      const cronTag = cron ? ` with cron <code>${esc(String(cron))}</code>` : '';
      const msgTag = message ? ` saying "${esc(String(message).slice(0, 60))}"` : '';
      return `Wants to create a recurring task${cronTag}${channelTag}${msgTag}.`;
    }

    // Non-destructive mutations
    if (tool.endsWith('snooze-reminder') || tool.endsWith('_snooze-reminder')) {
      return `Wants to postpone reminder <code>${esc(String(reminderId ?? '?'))}</code>${delay ? ` by <strong>${esc(String(delay))}</strong>` : ''}.`;
    }
    if (tool.endsWith('update-reminder') || tool.endsWith('_update-reminder')) {
      return `Wants to update reminder <code>${esc(String(reminderId ?? '?'))}</code>${time ? ` (new time)` : ''}${message ? ` (new message)` : ''}.`;
    }
    if (tool.endsWith('update-recurring-task') || tool.endsWith('_update-recurring-task')) {
      return `Wants to update recurring task <code>${esc(String(taskId ?? '?'))}</code>.`;
    }
    if (tool.endsWith('enable-recurring-task') || tool.endsWith('_enable-recurring-task')) {
      return `Wants to enable (resume) recurring task <code>${esc(String(taskId ?? '?'))}</code>.`;
    }
    if (tool.endsWith('disable-recurring-task') || tool.endsWith('_disable-recurring-task')) {
      return `Wants to disable (pause) recurring task <code>${esc(String(taskId ?? '?'))}</code>.`;
    }

    // Destructive
    if (tool.endsWith('cancel-reminder') || tool.endsWith('_cancel-reminder')) {
      return `Wants to cancel reminder <code>${esc(String(reminderId ?? '?'))}</code>. This action is <strong style="color:${semanticColors.red}">irreversible</strong>.`;
    }
    if (tool.endsWith('bulk-cancel') || tool.endsWith('_bulk-cancel')) {
      const filterTag = channelId
        ? ` in channel <code>${esc(String(channelId).slice(0, 24))}</code>`
        : input?.before
          ? ` scheduled before the given time`
          : input?.ids?.length
            ? ` with ${input.ids.length} explicit IDs`
            : '';
      return `Wants to bulk-cancel pending reminders${filterTag}. This action is <strong style="color:${semanticColors.red}">irreversible</strong>.`;
    }
    if (tool.endsWith('delete-recurring-task') || tool.endsWith('_delete-recurring-task')) {
      return `Wants to permanently delete recurring task <code>${esc(String(taskId ?? '?'))}</code>. This action is <strong style="color:${semanticColors.red}">irreversible</strong>.`;
    }
  }

  // ==========================================================================
  // TEROS CORE (platform management: agents, workspaces, apps, skills, access)
  //
  // These tools modify the user's own Teros setup — not external services.
  // The target of each action is an internal resource (agent, workspace, skill)
  // that the user may not remember by ID. We try to surface whatever the
  // input provides (name, role, description) and fall back to a truncated ID.
  // ==========================================================================

  // Read-only (list / get / details). Still surface so the user sees what the
  // agent wants to inspect. No destructive wording — severity is naturally low.
  if (short === 'list-agents' || short === 'workspace-agent-list') {
    const ws = input?.workspaceId
      ? ` in workspace <code>${esc(shortId(input.workspaceId))}</code>`
      : ' in the current workspace';
    return `Wants to list the agents${ws}.`;
  }
  if (short === 'get-agent') {
    return `Wants to read details of agent <code>${esc(shortId(input?.agentId))}</code>.`;
  }
  if (short === 'list-agent-apps') {
    return `Wants to list the apps agent <code>${esc(shortId(input?.agentId))}</code> has access to.`;
  }
  if (short === 'get-agent-providers') {
    return `Wants to read the LLM provider configuration of agent <code>${esc(shortId(input?.agentId))}</code>.`;
  }
  if (short === 'list-workspaces') {
    return 'Wants to list your workspaces.';
  }
  if (short === 'get-workspace') {
    return `Wants to read details of workspace <code>${esc(shortId(input?.workspaceId))}</code>.`;
  }
  if (short === 'list-apps' || short === 'workspace-app-list') {
    const ws = input?.workspaceId
      ? ` in workspace <code>${esc(shortId(input.workspaceId))}</code>`
      : '';
    return `Wants to list installed apps${ws}.`;
  }
  if (short === 'get-app') {
    return `Wants to read details of app <code>${esc(shortId(input?.appId))}</code>.`;
  }
  if (short === 'list-app-access') {
    return `Wants to see which agents have access to app <code>${esc(shortId(input?.appId))}</code>.`;
  }
  if (short === 'list-catalog') {
    return 'Wants to list the available MCAs in the catalog.';
  }
  if (short === 'list-providers') {
    return 'Wants to list your configured LLM providers.';
  }
  if (short === 'skill-list') {
    const ws = input?.workspaceId
      ? ` in workspace <code>${esc(shortId(input.workspaceId))}</code>`
      : '';
    return `Wants to list skills${ws}.`;
  }
  if (short === 'skill-get-agent-skills') {
    return `Wants to list the skills assigned to agent <code>${esc(shortId(input?.agentId))}</code>.`;
  }

  // Agents
  if (short === 'create-agent') {
    const name = esc(input?.fullName ?? input?.name ?? 'a new agent');
    const role = input?.role ? ` (${esc(input.role)})` : '';
    const core = input?.coreId ? ` based on the <code>${esc(input.coreId)}</code> template` : '';
    const ws = input?.workspaceId
      ? ` in workspace <code>${esc(shortId(input.workspaceId))}</code>`
      : ' as a <strong>global</strong> agent';
    return `Will create agent <strong>${name}</strong>${role}${core}${ws}.`;
  }

  if (short === 'update-agent') {
    const id = esc(shortId(input?.agentId));
    const changes: string[] = [];
    if (input?.name) changes.push(`name → <strong>${esc(input.name)}</strong>`);
    if (input?.fullName) changes.push(`full name → <strong>${esc(input.fullName)}</strong>`);
    if (input?.role) changes.push(`role → <strong>${esc(input.role)}</strong>`);
    if (input?.intro) changes.push('new intro text');
    if (input?.context !== undefined) changes.push('updated context (agent system prompt)');
    if (input?.responseStyle) changes.push(`response style → <strong>${esc(input.responseStyle)}</strong>`);
    if (input?.avatarUrl) changes.push('new avatar');
    const list = changes.length ? changes.join(', ') : '(no visible changes)';
    return `Will update agent <code>${id}</code>:<br>${list}.`;
  }

  if (short === 'delete-agent') {
    const id = esc(shortId(input?.agentId));
    return (
      `Will ${DANGER}permanently delete</strong> agent <code>${id}</code>.` +
      `<br>This cannot be undone. All its access grants to apps will also be removed.` +
      `<br>Past conversations will still exist but will reference the deleted agent.`
    );
  }

  if (short === 'set-agent-providers') {
    const id = esc(shortId(input?.agentId));
    const providers = Array.isArray(input?.providerIds) ? input.providerIds : [];
    if (providers.length === 0) {
      return `Will clear the list of available LLM providers for agent <code>${id}</code> (it won't have any).`;
    }
    const list = providers.map((p: unknown) => `<code>${esc(p)}</code>`).join(', ');
    return `Will replace the list of LLM providers this agent can use with: ${list}.`;
  }

  if (short === 'set-agent-preferred-provider') {
    const id = esc(shortId(input?.agentId));
    if (!input?.providerId) {
      return `Will clear the preferred LLM provider for agent <code>${id}</code> (system will auto-pick).`;
    }
    return `Will set the default LLM provider for agent <code>${id}</code> to <code>${esc(input.providerId)}</code>.`;
  }

  // Workspaces
  if (short === 'create-workspace') {
    const name = esc(input?.name ?? 'a new workspace');
    const desc = input?.description ? ` — "${esc(input.description)}"` : '';
    return `Will create workspace <strong>${name}</strong>${desc}.<br>A dedicated volume will be created and attached.`;
  }

  if (short === 'update-workspace') {
    const id = esc(shortId(input?.workspaceId));
    const changes: string[] = [];
    if (input?.name) changes.push(`name → <strong>${esc(input.name)}</strong>`);
    if (input?.description) changes.push('new description');
    if (input?.context !== undefined)
      changes.push(`${WARN}context updated</strong> (injected into every agent's system prompt in this workspace)`);
    const list = changes.length ? changes.join(', ') : '(no visible changes)';
    return `Will update workspace <code>${id}</code>:<br>${list}.`;
  }

  if (short === 'archive-workspace') {
    const id = esc(shortId(input?.workspaceId));
    return (
      `Will ${WARN}archive</strong> workspace <code>${id}</code>.` +
      `<br>The workspace, its members and its volume are preserved but hidden.` +
      `<br>Reversible by an admin reactivating it.`
    );
  }

  if (short === 'add-workspace-member') {
    const ws = esc(shortId(input?.workspaceId));
    const user = esc(shortId(input?.userId));
    const role = esc(input?.role ?? '?');
    const meaning: Record<string, string> = {
      admin: 'full control',
      write: 'can modify content',
      read: 'view-only access',
    };
    const tip = meaning[role] ? ` — ${meaning[role]}` : '';
    return `Will add user <code>${user}</code> to workspace <code>${ws}</code> as <strong>${role}</strong>${tip}.`;
  }

  if (short === 'remove-workspace-member') {
    const ws = esc(shortId(input?.workspaceId));
    const user = esc(shortId(input?.userId));
    return (
      `Will ${WARN}remove</strong> user <code>${user}</code> from workspace <code>${ws}</code>.` +
      `<br>This does NOT revoke the user's agent→app access grants — those must be revoked separately.`
    );
  }

  if (short === 'update-workspace-member-role') {
    const ws = esc(shortId(input?.workspaceId));
    const user = esc(shortId(input?.userId));
    const role = esc(input?.role ?? '?');
    return `Will change role of <code>${user}</code> in workspace <code>${ws}</code> to <strong>${role}</strong>.`;
  }

  // Apps
  if (short === 'install-app') {
    const mca = esc(input?.mcaId ?? 'an MCA');
    const name = input?.name ? ` as "${esc(input.name)}"` : '';
    const ws = input?.workspaceId
      ? ` in workspace <code>${esc(shortId(input.workspaceId))}</code>`
      : ' in your Private Workspace';
    return `Will install <strong>${mca}</strong>${name}${ws}.`;
  }

  if (short === 'uninstall-app') {
    const id = esc(shortId(input?.appId));
    return (
      `Will ${DANGER}permanently uninstall</strong> app <code>${id}</code>.` +
      `<br>This cannot be undone. All agent access grants to this app will be removed.`
    );
  }

  if (short === 'rename-app') {
    const id = esc(shortId(input?.appId));
    const name = esc(input?.name ?? '?');
    return `Will rename app <code>${id}</code> to <strong>${name}</strong>.`;
  }

  // Access control (apps ↔ agents)
  if (short === 'grant-app-access') {
    const agent = esc(shortId(input?.agentId));
    const app = esc(shortId(input?.appId));
    return `Will give agent <code>${agent}</code> access to app <code>${app}</code>.<br>The agent will be able to call all the app's tools.`;
  }

  if (short === 'revoke-app-access') {
    const agent = esc(shortId(input?.agentId));
    const app = esc(shortId(input?.appId));
    return `Will ${WARN}revoke</strong> agent <code>${agent}</code>'s access to app <code>${app}</code>.<br>The agent will no longer be able to call its tools.`;
  }

  // Skills
  if (short === 'skill-create') {
    const name = esc(input?.name ?? 'a new skill');
    const ws = input?.workspaceId ? ` in workspace <code>${esc(shortId(input.workspaceId))}</code>` : '';
    const desc = input?.description ? ` — "${esc(input.description)}"` : '';
    return `Will create skill <strong>${name}</strong>${ws}${desc}.`;
  }

  if (short === 'skill-update') {
    const id = esc(shortId(input?.skillId));
    const changes: string[] = [];
    if (input?.name) changes.push(`name → <strong>${esc(input.name)}</strong>`);
    if (input?.description) changes.push('new description');
    if (input?.content !== undefined) changes.push('updated content (injected into agent prompts when enabled)');
    const list = changes.length ? changes.join(', ') : '(no visible changes)';
    return `Will update skill <code>${id}</code>:<br>${list}.`;
  }

  if (short === 'skill-delete') {
    const id = esc(shortId(input?.skillId));
    return (
      `Will ${DANGER}permanently delete</strong> skill <code>${id}</code>.` +
      `<br>This cannot be undone. All agent access grants for this skill will be removed.`
    );
  }

  if (short === 'skill-grant-access') {
    const agent = esc(shortId(input?.agentId));
    const skill = esc(shortId(input?.skillId));
    return (
      `Will give agent <code>${agent}</code> the skill <code>${skill}</code>.` +
      `<br>Once enabled, the skill's content is injected into the agent's system prompt.`
    );
  }

  if (short === 'skill-revoke-access') {
    const agent = esc(shortId(input?.agentId));
    const skill = esc(shortId(input?.skillId));
    return `Will ${WARN}revoke</strong> skill <code>${skill}</code> from agent <code>${agent}</code>.<br>The skill will no longer be injected into the agent's prompt.`;
  }

  if (short === 'skill-set-enabled') {
    const agent = esc(shortId(input?.agentId));
    const skill = esc(shortId(input?.skillId));
    const on = input?.enabled === true;
    const verb = on ? `<strong>enable</strong>` : `${WARN}disable</strong>`;
    const effect = on
      ? "The skill's content will be injected into the agent's system prompt."
      : 'The skill remains assigned but will not be injected into the prompt.';
    return `Will ${verb} skill <code>${skill}</code> for agent <code>${agent}</code>.<br>${effect}`;
  }

  // --- Linear MCAs ---
  // Tools are registered as `linear_linear-<verb>-<noun>`, so after splitting
  // on '_' the short form is `linear-<verb>-<noun>`. We also tolerate the
  // unprefixed `<verb>-<noun>` (useful during local testing).
  const linearShort = short.startsWith('linear-') ? short.slice('linear-'.length) : short;

  // Read-only (neutral)
  if (tool.includes('linear') && linearShort === 'list-issues') {
    const parts: string[] = [];
    if (input?.teamId) parts.push(`team <code>${shortId(input.teamId)}</code>`);
    if (input?.status) parts.push(`status <code>${esc(String(input.status))}</code>`);
    if (input?.priority) parts.push(`priority <code>${esc(String(input.priority))}</code>`);
    if (input?.assigneeId) parts.push(`assignee <code>${shortId(input.assigneeId)}</code>`);
    const filters = parts.length ? ` (${parts.join(', ')})` : '';
    return `Will list Linear issues${filters}.`;
  }
  if (tool.includes('linear') && linearShort === 'get-issue') {
    return `Will read Linear issue <code>${esc(String(input?.issueId ?? '?'))}</code>.`;
  }
  if (tool.includes('linear') && linearShort === 'list-projects') {
    const team = input?.teamId ? ` (team <code>${shortId(input.teamId)}</code>)` : '';
    return `Will list Linear projects${team}.`;
  }
  if (tool.includes('linear') && linearShort === 'list-labels') {
    const team = input?.teamId ? ` for team <code>${shortId(input.teamId)}</code>` : '';
    return `Will list Linear labels${team}.`;
  }
  if (tool.includes('linear') && linearShort === 'list-teams') {
    return 'Will list Linear teams in the workspace.';
  }
  if (tool.includes('linear') && linearShort === 'list-users') {
    const team = input?.teamId ? ` for team <code>${shortId(input.teamId)}</code>` : '';
    return `Will list Linear users${team}.`;
  }
  if (tool.includes('linear') && linearShort === 'list-workflow-states') {
    return `Will list workflow states for team <code>${shortId(String(input?.teamId ?? '?'))}</code>.`;
  }

  // Writes (WARN)
  if (tool.includes('linear') && linearShort === 'create-issue') {
    const title = input?.title ? `"${esc(truncate(String(input.title), 60))}"` : '(untitled)';
    return `Will ${WARN}create</strong> Linear issue ${title} in team <code>${shortId(String(input?.teamId ?? '?'))}</code>.`;
  }
  if (tool.includes('linear') && linearShort === 'update-issue') {
    const changes: string[] = [];
    if (input?.title) changes.push(`title=${esc(truncate(String(input.title), 40))}`);
    if (input?.stateId) changes.push(`state=${shortId(String(input.stateId))}`);
    if (input?.priority) changes.push(`priority=${esc(String(input.priority))}`);
    if (input?.assigneeId) changes.push(`assignee=${shortId(String(input.assigneeId))}`);
    if (input?.projectId) changes.push(`project=${shortId(String(input.projectId))}`);
    if (input?.labelIds) changes.push(`labels=${input.labelIds.length}`);
    const summary = changes.length ? ` → ${changes.join(', ')}` : '';
    return `Will ${WARN}update</strong> Linear issue <code>${esc(String(input?.issueId ?? '?'))}</code>${summary}.`;
  }
  if (tool.includes('linear') && linearShort === 'add-comment') {
    const preview = input?.body ? `: "${esc(truncate(String(input.body), 60))}"` : '';
    return `Will ${WARN}post a comment</strong> on <code>${esc(String(input?.issueId ?? '?'))}</code>${preview}.`;
  }
  if (tool.includes('linear') && linearShort === 'create-project') {
    const name = input?.name ? `"${esc(truncate(String(input.name), 50))}"` : '(unnamed)';
    const teams = Array.isArray(input?.teamIds) ? input.teamIds.length : 0;
    return `Will ${WARN}create</strong> Linear project ${name} across ${teams} team${teams !== 1 ? 's' : ''}.`;
  }
  if (tool.includes('linear') && linearShort === 'add-issues-to-project') {
    const count = Array.isArray(input?.issueIds) ? input.issueIds.length : 0;
    return `Will ${WARN}attach ${count} issue${count !== 1 ? 's' : ''}</strong> to project <code>${shortId(String(input?.projectId ?? '?'))}</code>.`;
  }
  if (tool.includes('linear') && linearShort === 'remove-issues-from-project') {
    const count = Array.isArray(input?.issueIds) ? input.issueIds.length : 0;
    return `Will ${WARN}detach ${count} issue${count !== 1 ? 's' : ''}</strong> from their project.`;
  }
  if (tool.includes('linear') && linearShort === 'create-label') {
    const name = input?.name ? `"${esc(truncate(String(input.name), 40))}"` : '(unnamed)';
    return `Will ${WARN}create</strong> Linear label ${name} in team <code>${shortId(String(input?.teamId ?? '?'))}</code>.`;
  }
  if (tool.includes('linear') && linearShort === 'update-label') {
    return `Will ${WARN}update</strong> Linear label <code>${shortId(String(input?.labelId ?? '?'))}</code>.`;
  }
  if (tool.includes('linear') && linearShort === 'add-labels-to-issue') {
    const count = Array.isArray(input?.labelIds) ? input.labelIds.length : 0;
    return `Will ${WARN}add ${count} label${count !== 1 ? 's' : ''}</strong> to <code>${esc(String(input?.issueId ?? '?'))}</code>.`;
  }
  if (tool.includes('linear') && linearShort === 'remove-labels-from-issue') {
    const count = Array.isArray(input?.labelIds) ? input.labelIds.length : 0;
    return `Will ${WARN}remove ${count} label${count !== 1 ? 's' : ''}</strong> from <code>${esc(String(input?.issueId ?? '?'))}</code>.`;
  }

  // Destructive (DANGER)
  if (tool.includes('linear') && linearShort === 'archive-issue') {
    return `Will ${WARN}archive</strong> Linear issue <code>${esc(String(input?.issueId ?? '?'))}</code>.<br>Reversible by un-archiving.`;
  }
  if (tool.includes('linear') && linearShort === 'delete-issue') {
    return `Will ${DANGER}permanently delete</strong> Linear issue <code>${esc(String(input?.issueId ?? '?'))}</code>.<br>This cannot be undone.`;
  }
  if (tool.includes('linear') && linearShort === 'delete-label') {
    return `Will ${DANGER}permanently delete</strong> Linear label <code>${shortId(String(input?.labelId ?? '?'))}</code>.<br>The label will be removed from all issues.`;
  }
  if (tool.includes('linear') && linearShort === 'delete-project') {
    return `Will ${DANGER}permanently delete</strong> Linear project <code>${shortId(String(input?.projectId ?? '?'))}</code>.<br>All issues in this project become detached (not deleted). This cannot be undone.`;
  }

  // --- Google Calendar MCA ---
  // Tools registered as `<appName>_calendar-<verb>-<noun>` (or `-health-check`).
  // The short form keeps the `calendar-` prefix.
  if (tool.includes('calendar') && short === '-health-check') {
    return 'Will check Google Calendar credentials and connectivity (read-only).';
  }
  if (tool.includes('calendar') && short === 'calendar-list-calendars') {
    return 'Will list your Google calendars (primary, secondary, shared).';
  }
  if (tool.includes('calendar') && short === 'calendar-list-events') {
    const cal = input?.calendarId
      ? `calendar <code>${esc(String(input.calendarId))}</code>`
      : 'primary calendar';
    const range =
      input?.startDate && input?.endDate
        ? ` from <code>${esc(String(input.startDate))}</code> to <code>${esc(String(input.endDate))}</code>`
        : '';
    return `Will list events on ${cal}${range}.`;
  }
  if (tool.includes('calendar') && short === 'calendar-get-event') {
    return `Will read calendar event <code>${esc(String(input?.eventId ?? '?'))}</code>.`;
  }
  if (tool.includes('calendar') && short === 'calendar-search-events') {
    const q = input?.query ? `"${esc(truncate(String(input.query), 50))}"` : '(empty query)';
    return `Will search calendar events for ${q}.`;
  }
  if (tool.includes('calendar') && short === 'calendar-create-event') {
    const title = input?.summary ? `"${esc(truncate(String(input.summary), 60))}"` : '(no title)';
    const time = input?.start ? ` at <code>${esc(String(input.start))}</code>` : '';
    const meet = input?.addConference ? ' with a Google Meet link' : '';
    const notify =
      input?.sendUpdates && input.sendUpdates !== 'none'
        ? ` and ${WARN}notify attendees</strong>`
        : '';
    return `Will ${WARN}create</strong> calendar event ${title}${time}${meet}${notify}.`;
  }
  if (tool.includes('calendar') && short === 'calendar-update-event') {
    const id = `<code>${esc(String(input?.eventId ?? '?'))}</code>`;
    const changes: string[] = [];
    if (input?.summary) changes.push(`title=${esc(truncate(String(input.summary), 40))}`);
    if (input?.start) changes.push(`start=${esc(String(input.start))}`);
    if (input?.end) changes.push(`end=${esc(String(input.end))}`);
    if (Array.isArray(input?.addAttendees)) changes.push(`+${input.addAttendees.length} attendees`);
    if (Array.isArray(input?.removeAttendees))
      changes.push(`-${input.removeAttendees.length} attendees`);
    if (Array.isArray(input?.replaceAttendees))
      changes.push(`${DANGER}replace attendees</strong>=${input.replaceAttendees.length}`);
    const summary = changes.length ? ` → ${changes.join(', ')}` : '';
    const notify =
      input?.sendUpdates && input.sendUpdates !== 'none'
        ? ` and ${WARN}notify attendees</strong>`
        : '';
    return `Will ${WARN}update</strong> calendar event ${id}${summary}${notify}.`;
  }
  if (tool.includes('calendar') && short === 'calendar-delete-event') {
    const id = `<code>${esc(String(input?.eventId ?? '?'))}</code>`;
    const notify =
      input?.sendUpdates && input.sendUpdates !== 'none' ? ' and send a cancellation notice' : '';
    return `Will ${DANGER}permanently delete</strong> calendar event ${id}${notify}.<br>This cannot be undone.`;
  }
  if (tool.includes('calendar') && short === 'calendar-get-free-busy') {
    const ids =
      Array.isArray(input?.calendarIds) && input.calendarIds.length > 0
        ? input.calendarIds.map((id: string) => `<code>${esc(id)}</code>`).join(', ')
        : '<code>primary</code>';
    return `Will check free/busy for ${ids}.`;
  }
  if (tool.includes('calendar') && short === 'calendar-respond-to-event') {
    const id = `<code>${esc(String(input?.eventId ?? '?'))}</code>`;
    const response = String(input?.response ?? 'tentative');
    const verb = response === 'declined' ? `${WARN}decline</strong>` : response === 'accepted' ? '<strong>accept</strong>' : `${WARN}mark tentative</strong>`;
    const notify =
      input?.sendUpdates && input.sendUpdates !== 'none'
        ? ` and ${WARN}notify the organizer + attendees</strong>`
        : '';
    return `Will ${verb} the invitation to event ${id}${notify}.`;
  }
  if (tool.includes('calendar') && short === 'calendar-quick-add-event') {
    const text = input?.text ? `"${esc(truncate(String(input.text), 80))}"` : '(empty)';
    const notify =
      input?.sendUpdates && input.sendUpdates !== 'none'
        ? ` and ${WARN}notify attendees</strong>`
        : '';
    return `Will ${WARN}create</strong> a calendar event from ${text} (Google parses the title and time)${notify}.`;
  }
  // Sprint 4 — specialized eventTypes + helpers
  if (tool.includes('calendar') && short === 'calendar-create-focus-time') {
    const range = input?.start && input?.end
      ? ` from <code>${esc(String(input.start))}</code> to <code>${esc(String(input.end))}</code>`
      : '';
    const decline =
      input?.autoDeclineMode && input.autoDeclineMode !== 'declineNone'
        ? ` (${WARN}auto-declines conflicts</strong>: ${esc(String(input.autoDeclineMode))})`
        : '';
    return `Will ${WARN}block focus time</strong>${range}${decline}.`;
  }
  if (tool.includes('calendar') && short === 'calendar-create-out-of-office') {
    const range = input?.start && input?.end
      ? ` from <code>${esc(String(input.start))}</code> to <code>${esc(String(input.end))}</code>`
      : '';
    const mode = input?.autoDeclineMode ?? 'declineAllConflictingInvitations';
    return `Will ${WARN}mark you Out of Office</strong>${range}. Conflicting invitations will be auto-declined: <code>${esc(String(mode))}</code>.`;
  }
  if (tool.includes('calendar') && short === 'calendar-set-working-location') {
    const type = input?.type ? esc(String(input.type)) : '?';
    const where =
      input?.type === 'officeLocation' && input?.officeLocation?.label
        ? ` (${esc(String(input.officeLocation.label))})`
        : input?.type === 'customLocation' && input?.customLocation?.label
          ? ` (${esc(String(input.customLocation.label))})`
          : '';
    return `Will mark you working from <code>${type}</code>${where}.`;
  }
  if (tool.includes('calendar') && short === 'calendar-get-settings') {
    if (input?.setting) {
      return `Will read your Calendar setting <code>${esc(String(input.setting))}</code>.`;
    }
    return 'Will read your Calendar preferences (timezone, locale, week start, ...).';
  }
  if (tool.includes('calendar') && short === 'calendar-get-colors') {
    return 'Will read the official Google Calendar color palette.';
  }
  if (tool.includes('calendar') && short === 'calendar-move-event') {
    const id = `<code>${esc(String(input?.eventId ?? '?'))}</code>`;
    const src = `<code>${esc(String(input?.sourceCalendarId ?? '?'))}</code>`;
    const dst = `<code>${esc(String(input?.destinationCalendarId ?? '?'))}</code>`;
    const notify =
      input?.sendUpdates && input.sendUpdates !== 'none'
        ? ` and ${WARN}notify attendees</strong>`
        : '';
    return `Will ${WARN}move event ${id}</strong> from ${src} to ${dst}${notify}.`;
  }
  if (tool.includes('calendar') && short === 'calendar-import-event') {
    const uid = input?.iCalUID ? esc(truncate(String(input.iCalUID), 40)) : '?';
    const dst = `<code>${esc(String(input?.calendarId ?? 'primary'))}</code>`;
    return `Will ${WARN}import an external event</strong> with iCalUID <code>${uid}</code> into ${dst}.`;
  }
  if (tool.includes('calendar') && short === 'calendar-list-instances') {
    return `Will list instances of recurring event <code>${esc(String(input?.eventId ?? '?'))}</code>.`;
  }

  // ==========================================================================
  // NOTION (mca.notion)
  //
  // Only the mutating tools need explicit copy — read-only tools (search,
  // get-page, list-comments, list-users) get permission ambiently per app and
  // fall through to the generic fallback below.
  // ==========================================================================
  if (short === 'create-page') {
    const title = input?.title ? esc(truncate(String(input.title), 40)) : 'a new page';
    const where = input?.parentType === 'database' ? 'in a database' : 'under a page';
    return `Will create page <strong>${title}</strong> ${where} on Notion.`;
  }
  if (short === 'update-page') {
    if (input?.archived === true) {
      return `Will move page <code>${esc(shortId(input?.pageId))}</code> to the Notion trash. Reversible from the Notion UI.`;
    }
    if (input?.archived === false) {
      return `Will restore page <code>${esc(shortId(input?.pageId))}</code> from the Notion trash.`;
    }
    return `Will update page <code>${esc(shortId(input?.pageId))}</code> on Notion.`;
  }
  if (short === 'update-page-markdown') {
    return `Will ${WARN}replace</strong> the body of page <code>${esc(shortId(input?.pageId))}</code> with new markdown.`;
  }
  if (short === 'duplicate-page') {
    return `Will duplicate page <code>${esc(shortId(input?.pageId))}</code> on Notion.`;
  }
  if (short === 'create-database') {
    const title = input?.title ? esc(truncate(String(input.title), 40)) : 'a new database';
    return `Will create database <strong>${title}</strong> on Notion.`;
  }
  if (short === 'update-database-schema') {
    return `Will modify the schema of database <code>${esc(shortId(input?.databaseId))}</code>.`;
  }
  if (short === 'create-database-item') {
    const cols = input?.properties && typeof input.properties === 'object'
      ? Object.keys(input.properties).slice(0, 3).join(', ')
      : '';
    const colsLabel = cols ? ` with ${esc(cols)}` : '';
    return `Will insert a new row${colsLabel} into database <code>${esc(shortId(input?.databaseId))}</code>.`;
  }
  if (short === 'update-database-item') {
    if (input?.archived === true) {
      return `Will archive row <code>${esc(shortId(input?.pageId))}</code> on Notion.`;
    }
    if (input?.archived === false) {
      return `Will restore row <code>${esc(shortId(input?.pageId))}</code> from the Notion trash.`;
    }
    const cols = input?.properties && typeof input.properties === 'object'
      ? Object.keys(input.properties).slice(0, 3).join(', ')
      : '';
    const colsLabel = cols ? ` (${esc(cols)})` : '';
    return `Will update row <code>${esc(shortId(input?.pageId))}</code>${colsLabel} on Notion.`;
  }
  if (short === 'append-blocks') {
    return `Will append content under <code>${esc(shortId(input?.blockId))}</code> on Notion.`;
  }
  if (short === 'create-advanced-blocks') {
    const t = input?.blockType ? esc(String(input.blockType)) : 'a block';
    return `Will create a ${t} block on Notion.`;
  }
  if (short === 'create-column-layout') {
    return 'Will create a column layout on Notion.';
  }
  if (short === 'update-block') {
    return `Will update block <code>${esc(shortId(input?.blockId))}</code> on Notion.`;
  }
  if (short === 'delete-block') {
    return (
      `Will ${WARN}delete</strong> block <code>${esc(shortId(input?.blockId))}</code> on Notion. ` +
      'Recoverable from the Notion trash.'
    );
  }
  if (short === 'set-page-icon' || short === 'set-page-cover') {
    return `Will update the page ${short === 'set-page-icon' ? 'icon' : 'cover'} on Notion.`;
  }
  if (short === 'create-comment') {
    return 'Will post a new comment on Notion.';
  }
  if (short === 'update-comment') {
    return `Will edit comment <code>${esc(shortId(input?.commentId))}</code> on Notion.`;
  }
  if (short === 'delete-comment') {
    return (
      `Will ${WARN}delete</strong> comment <code>${esc(shortId(input?.commentId))}</code> on Notion. ` +
      'This cannot be undone from the API.'
    );
  }
  if (short === 'upload-file') {
    const name = input?.name ? ` (<code>${esc(String(input.name))}</code>)` : '';
    return `Will upload a file${name} to Notion.`;
  }
  if (short === 'get-page-markdown') {
    return `Will read page <code>${esc(shortId(input?.pageId))}</code> as markdown.`;
  }

  // Hunter (email finder) — all read-only lookups against api.hunter.io
  if (short === 'domain-search') {
    const domain = input?.domain ? `<code>${esc(String(input.domain))}</code>` : 'a company domain';
    return `Wants to look up professional email addresses for ${domain} via Hunter.io.`;
  }
  if (short === 'email-finder') {
    const name = [input?.first_name, input?.last_name].filter(Boolean).map(String).join(' ');
    const who = name ? `<strong>${esc(name)}</strong>` : 'a person';
    const domain = input?.domain ? ` at <code>${esc(String(input.domain))}</code>` : '';
    return `Wants to find the email address of ${who}${domain} via Hunter.io.`;
  }
  if (short === 'email-verifier') {
    const email = input?.email ? `<code>${esc(String(input.email))}</code>` : 'an email address';
    return `Wants to verify the deliverability of ${email} via Hunter.io.`;
  }

  // --- HubSpot (mca.hubspot) ---
  // CRM objects (contacts/companies/deals/tickets) + engagements/lists/associations/
  // pipelines/conversations. GUARDED by MCA: short names like create-ticket /
  // list-contacts / get-list COLLIDE with other MCAs (Zendesk, Google Contacts,
  // Holded, Slack), so apply these descriptions only when the tool belongs to the
  // HubSpot app. toolName is `${appName}_${short}`; the default app name contains
  // "hubspot". If the app is renamed, the tool falls through to the generic fallback
  // (correct, not mis-attributed to HubSpot).
  if (tool.toLowerCase().includes('hubspot')) {
    const HS_OBJECTS: Record<string, string> = {
      contact: 'contact',
      contacts: 'contacts',
      company: 'company',
      companies: 'companies',
      deal: 'deal',
      deals: 'deals',
      ticket: 'ticket',
      tickets: 'tickets',
      engagement: 'engagement (note/call/email/meeting/task)',
      engagements: 'engagements',
      list: 'list',
      lists: 'lists',
      association: 'association',
      associations: 'associations',
      pipeline: 'pipeline',
      pipelines: 'pipelines',
      conversation: 'conversation',
      conversations: 'conversations',
    };
    const hsMatch = short.match(/^(create|get|list|update|delete)-([a-z]+)$/);
    if (hsMatch && HS_OBJECTS[hsMatch[2]]) {
      const verb = hsMatch[1];
      const obj = HS_OBJECTS[hsMatch[2]];
      const rawId =
        input?.contactId ??
        input?.companyId ??
        input?.dealId ??
        input?.ticketId ??
        input?.engagementId ??
        input?.associationId ??
        input?.pipelineId ??
        input?.conversationId ??
        input?.listId ??
        input?.id;
      const idTag = rawId ? ` <code>${esc(shortId(rawId))}</code>` : '';
      if (verb === 'create') return `Will ${WARN}create</strong> a HubSpot ${obj}.`;
      if (verb === 'update') return `Will ${WARN}update</strong> HubSpot ${obj}${idTag}.`;
      if (verb === 'delete')
        return `Will ${DANGER}delete</strong> HubSpot ${obj}${idTag}.`;
      return `Wants to ${verb} HubSpot ${obj}${idTag}.`;
    }
    if (short === 'send-conversation-message') {
      return `Will ${WARN}send a message</strong> in HubSpot conversation <code>${esc(shortId(input?.conversationId))}</code>.`;
    }
    if (short === 'search' && typeof input?.objectType === 'string') {
      return `Wants to search HubSpot ${esc(String(input.objectType))}.`;
    }
  }

  // --- ActiveCampaign (mca.activecampaign) ---
  // CRM + email marketing: contacts, lists, campaigns, deals, tags. Short names
  // (list-contacts / create-deal / get-campaign) collide with other MCAs, so gate
  // on the app name (default contains "activecampaign"); a renamed app falls
  // through to the generic fallback (correct, not mis-attributed).
  if (tool.includes('activecampaign')) {
    const idTag = input?.id ? ` <code>${esc(shortId(input.id))}</code>` : '';
    switch (short) {
      case 'list-contacts':
        return 'Wants to list ActiveCampaign contacts.';
      case 'get-contact':
        return `Wants to read ActiveCampaign contact${idTag}.`;
      case 'create-contact':
        return `Will ${WARN}create</strong> an ActiveCampaign contact${
          input?.email ? ` <code>${esc(String(input.email))}</code>` : ''
        }.`;
      case 'update-contact':
        return `Will ${WARN}update</strong> ActiveCampaign contact${idTag}.`;
      case 'delete-contact':
        return `Will ${DANGER}permanently delete</strong> ActiveCampaign contact${idTag}.`;
      case 'list-lists':
        return 'Wants to list ActiveCampaign subscriber lists.';
      case 'subscribe-contact-to-list': {
        const unsub = input?.status === 'unsubscribed';
        return `Will ${WARN}${unsub ? 'unsubscribe' : 'subscribe'}</strong> contact <code>${esc(
          shortId(input?.contactId),
        )}</code> ${unsub ? 'from' : 'to'} list <code>${esc(shortId(input?.listId))}</code>.`;
      }
      case 'list-campaigns':
        return 'Wants to list ActiveCampaign campaigns.';
      case 'get-campaign':
        return `Wants to read ActiveCampaign campaign${idTag}.`;
      case 'list-deals':
        return 'Wants to list ActiveCampaign deals.';
      case 'get-deal':
        return `Wants to read ActiveCampaign deal${idTag}.`;
      case 'create-deal':
        return `Will ${WARN}create</strong> an ActiveCampaign deal${
          input?.title ? ` <code>${esc(String(input.title))}</code>` : ''
        }.`;
      case 'list-tags':
        return 'Wants to list ActiveCampaign tags.';
      case 'add-tag-to-contact':
        return `Will ${WARN}tag</strong> contact <code>${esc(shortId(input?.contactId))}</code> with tag <code>${esc(
          shortId(input?.tagId),
        )}</code>.`;
    }
  }

  // --- Runn MCA (mca.runn) ---
  // Tools register as `<app>_runn-<verb>-<noun>`; after splitting on '_' the
  // short form is `runn-<verb>-<noun>`. Runn ids are numeric. Even read-only
  // tools get a description so the widget never falls back to the literal.
  if (tool.includes('runn')) {
    const r = short.startsWith('runn-') ? short.slice('runn-'.length) : short;
    const pid = () => esc(String(input?.projectId ?? '?'));
    const person = () => esc(String(input?.personId ?? '?'));
    const scopeText = () =>
      input?.personId != null
        ? ` for person <code>${person()}</code>`
        : input?.projectId != null
          ? ` for project <code>${pid()}</code>`
          : '';

    // Read-only (neutral)
    if (r === 'list-projects') {
      const c = input?.clientId != null ? ` for client <code>${esc(String(input.clientId))}</code>` : '';
      return `Will list Runn projects${c}.`;
    }
    if (r === 'get-project') return `Will read Runn project <code>${pid()}</code>.`;
    if (r === 'list-people') return 'Will list Runn people.';
    if (r === 'get-person') return `Will read Runn person <code>${person()}</code>.`;
    if (r === 'list-placeholders') return 'Will list Runn placeholders.';
    if (r === 'list-assignments') return `Will list Runn assignments${scopeText()}.`;
    if (r === 'list-actuals') return `Will list Runn timesheets${scopeText()}.`;
    if (r === 'list-clients') return 'Will list Runn clients.';
    if (r === 'list-roles') return 'Will list Runn roles.';
    if (r === 'list-teams') return 'Will list Runn teams.';
    if (r === 'list-skills') return 'Will list Runn skills.';
    if (r === 'project-totals') return 'Will read Runn project time totals.';

    // Writes (WARN)
    if (r === 'create-project') {
      const name = input?.name ? `"${esc(String(input.name).slice(0, 60))}"` : '(unnamed)';
      return `Will ${WARN}create</strong> Runn project ${name} for client <code>${esc(String(input?.clientId ?? '?'))}</code>.`;
    }
    if (r === 'update-project') return `Will ${WARN}update</strong> Runn project <code>${pid()}</code>.`;
    if (r === 'create-person') {
      const name = [input?.firstName, input?.lastName].filter(Boolean).join(' ') || '(unnamed)';
      return `Will ${WARN}create</strong> Runn person "${esc(name.slice(0, 60))}" as role <code>${esc(String(input?.roleId ?? '?'))}</code>.`;
    }
    if (r === 'create-placeholder') {
      return `Will ${WARN}create</strong> a Runn placeholder for role <code>${esc(String(input?.roleId ?? '?'))}</code>.`;
    }
    if (r === 'create-assignment') {
      return `Will ${WARN}assign</strong> person <code>${person()}</code> to project <code>${pid()}</code> (${esc(String(input?.startDate ?? '?'))} → ${esc(String(input?.endDate ?? '?'))}).`;
    }
    if (r === 'create-actual') {
      return `Will ${WARN}log time</strong> for person <code>${person()}</code> on project <code>${pid()}</code> (${esc(String(input?.date ?? '?'))}).`;
    }
    if (r === 'create-client') {
      const name = input?.name ? `"${esc(String(input.name).slice(0, 60))}"` : '(unnamed)';
      return `Will ${WARN}create</strong> Runn client ${name}.`;
    }

    // Destructive (DANGER)
    if (r === 'delete-assignment') {
      return `Will ${DANGER}permanently delete</strong> Runn assignment <code>${esc(String(input?.assignmentId ?? '?'))}</code>.<br>This cannot be undone.`;
    }
  }

  // Generic fallback
  return `Wants to execute tool: <code>${esc(toolName)}</code>`;
}

/**
 * Extract key parameters to show as preview badges
 */
function getKeyParameters(
  toolName: string,
  input?: Record<string, any>,
): Array<{ key: string; value: string }> {
  if (!input) return [];

  const tool = toolName.toLowerCase();
  const params: Array<{ key: string; value: string }> = [];

  // Bash/Shell
  if (tool.includes('bash') || tool.includes('shell')) {
    if (input.command) params.push({ key: 'cmd', value: truncate(input.command, 50) });
    if (input.cwd) params.push({ key: 'cwd', value: truncate(input.cwd, 40) });
    return params;
  }

  // Filesystem
  if (tool.includes('filesystem') || tool.includes('file')) {
    if (input.path || input.filePath) {
      params.push({ key: 'path', value: truncate(input.path || input.filePath, 60) });
    }
    return params;
  }

  // Email
  if (tool.includes('mail')) {
    if (input.to) params.push({ key: 'to', value: truncate(input.to, 40) });
    if (input.subject) params.push({ key: 'subject', value: truncate(input.subject, 50) });
    return params;
  }

  // Calendar
  if (tool.includes('calendar')) {
    if (input.title || input.summary) {
      params.push({ key: 'title', value: truncate(input.title || input.summary, 40) });
    }
    if (input.date) params.push({ key: 'date', value: input.date });
    if (input.time) params.push({ key: 'time', value: input.time });
    return params;
  }

  // Generic: show first 3 keys
  return Object.entries(input)
    .slice(0, 3)
    .map(([key, value]) => ({
      key,
      value: truncate(String(value), 40),
    }));
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen) + '...';
}

/**
 * Format input for display in expanded view
 */
function formatInput(input: Record<string, any>): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

// ============================================================================
// Colors — mapped to the design system tokens (surface + semantic).
// Surface tokens (bg, text, border) are theme-adaptive via useColors().
// Semantic tokens (violet, red, amber, green) are theme-agnostic.
// ============================================================================

function usePermissionColors() {
  const c = useColors();
  const isDark = c.bgPage === surface.dark.bgPage;
  return {
    isDark,
    surface: c,
    // Purple accent for permissions (semantic, theme-agnostic)
    purple: semanticColors.violet,
    purpleBorder: controlsBarTokens.permission.modalBorder,

    // Risk levels — use the indicators tokens from the design system
    riskHigh: indicators.irreversible.fg,
    riskHighBg: indicators.irreversible.bg,
    riskHighBorder: indicators.irreversible.border,

    riskMedium: indicators.risk.fg,
    riskMediumBg: indicators.risk.bg,
    riskMediumBorder: indicators.risk.border,

    riskLow: semanticColors.green,
    riskLowBg: controlsBarTokens.allow.bg,
    riskLowBorder: controlsBarTokens.allow.border,

    // Backgrounds — adaptive surface tokens
    contextBg: c.bgCard,
    controlsBg: c.bgCardHover,
    expandedBg: c.bgCard,
    paramBadgeBg: c.bgInner,

    // Text — adaptive surface tokens
    primary: c.text,
    secondary: c.text2,
    muted: c.text3,
    mutedLight: c.text3,

    // Buttons — use controlsBar tokens (semantic, theme-agnostic)
    denyBg: controlsBarTokens.deny.bg,
    denyBorder: controlsBarTokens.deny.border,
    denyText: controlsBarTokens.deny.fg,

    allowBg: controlsBarTokens.allow.bg,
    allowBorder: controlsBarTokens.allow.border,
    allowText: controlsBarTokens.allow.fg,

    // Borders — adaptive
    border: c.border,
  };
}

// ============================================================================
// Components
// ============================================================================

interface RiskBadgeProps {
  level: RiskLevel;
}

function RiskBadge({ level }: RiskBadgeProps) {
  const colors = usePermissionColors();
  const config = {
    high: {
      text: 'High Risk',
      color: colors.riskHigh,
      bg: colors.riskHighBg,
      border: colors.riskHighBorder,
      icon: <AlertTriangle size={8} color={colors.riskHigh} />,
    },
    medium: {
      text: 'Medium Risk',
      color: colors.riskMedium,
      bg: colors.riskMediumBg,
      border: colors.riskMediumBorder,
      icon: <AlertTriangle size={8} color={colors.riskMedium} />,
    },
    low: {
      text: 'Low Risk',
      color: colors.riskLow,
      bg: colors.riskLowBg,
      border: colors.riskLowBorder,
      icon: <Check size={8} color={colors.riskLow} />,
    },
  };

  const { text, color, bg, border, icon } = config[level];

  return (
    <XStack
      alignItems="center"
      gap={3}
      paddingHorizontal={6}
      paddingVertical={2}
      borderRadius={4}
      backgroundColor={bg}
      borderWidth={1}
      borderColor={border}
    >
      {icon}
      <Text fontSize={9} fontWeight="600" color={color} textTransform="uppercase" letterSpacing={0.5}>
        {text}
      </Text>
    </XStack>
  );
}

interface ParamBadgeProps {
  paramKey: string;
  value: string;
}

function ParamBadge({ paramKey, value }: ParamBadgeProps) {
  const colors = usePermissionColors();
  return (
    <XStack
      alignItems="center"
      gap={3}
      paddingHorizontal={6}
      paddingVertical={2}
      borderRadius={4}
      backgroundColor={colors.paramBadgeBg}
      borderWidth={1}
      borderColor={colors.border}
    >
      <Text fontSize={10} fontFamily="$mono" color={colors.muted}>
        {paramKey}:
      </Text>
      <Text fontSize={10} fontFamily="$mono" color={colors.secondary}>
        {value}
      </Text>
    </XStack>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export function PermissionRequestWidget({
  permissionRequestId,
  appId,
  toolName,
  input,
}: PermissionRequestWidgetProps) {
  const { t } = useTranslation();
  const permissionCallbacks = usePermissionCallbacks();
  const colors = usePermissionColors();
  const [expanded, setExpanded] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);

  // Animation for expand/collapse
  const rotateAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(rotateAnim, {
      toValue: expanded ? 1 : 0,
      duration: 200,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, [expanded, rotateAnim]);

  const rotation = rotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '180deg'],
  });

  if (!permissionCallbacks) {
    return null;
  }

  const riskLevel = getRiskLevel(toolName, input);
  const description = getActionDescription(toolName, input);
  const keyParams = getKeyParameters(toolName, input);
  const formattedInput = input ? formatInput(input) : null;

  // Modal handlers
  const handleAllowAlways = () => {
    if (appId) {
      permissionCallbacks.onGrantAlways(permissionRequestId, appId, toolName);
    } else {
      permissionCallbacks.onGrant(permissionRequestId);
    }
    setModalVisible(false);
  };

  const handleDenyAlways = () => {
    if (appId) {
      permissionCallbacks.onDenyAlways(permissionRequestId, appId, toolName);
    } else {
      permissionCallbacks.onDeny(permissionRequestId);
    }
    setModalVisible(false);
  };

  const handleAllow = () => {
    permissionCallbacks.onGrant(permissionRequestId);
    setModalVisible(false);
  };

  const handleDeny = () => {
    permissionCallbacks.onDeny(permissionRequestId);
    setModalVisible(false);
  };

  // Menu item component for modal
  const MenuItem = ({
    icon,
    label,
    description: desc,
    onPress,
    color = colors.surface.text2,
  }: {
    icon: React.ReactNode;
    label: string;
    description?: string;
    onPress: () => void;
    color?: string;
  }) => (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 14,
      }}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: 8,
          backgroundColor: `${color}15`,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {icon}
      </View>
      <YStack flex={1}>
        <Text fontSize={15} color={color} fontWeight="600">
          {label}
        </Text>
        {desc && (
          <Text fontSize={12} color={colors.mutedLight} marginTop={2}>
            {desc}
          </Text>
        )}
      </YStack>
    </TouchableOpacity>
  );

  return (
    <>
      <YStack
        marginTop={-4}
        borderWidth={1}
        borderTopWidth={0}
        borderColor={colors.purpleBorder}
        borderBottomLeftRadius="$3"
        borderBottomRightRadius="$3"
        overflow="hidden"
        width="100%"
      >
        {/* Context Preview Section */}
        <YStack backgroundColor={colors.contextBg} padding={12} paddingTop={16} gap={8}>
          {/* Header with title and risk badge */}
          <XStack alignItems="center" gap={6}>
            <Shield size={12} color={colors.purple} />
            <Text
              flex={1}
              fontSize={10}
              fontWeight="600"
              color={colors.purple}
              textTransform="uppercase"
              letterSpacing={0.5}
            >
              Permission Required
            </Text>
            <RiskBadge level={riskLevel} />
          </XStack>

          {/* Description */}
          <Text
            fontSize={11}
            color={colors.secondary}
            lineHeight={16}
            dangerouslySetInnerHTML={{ __html: description }}
          />

          {/* Key parameters */}
          {keyParams.length > 0 && (
            <XStack flexWrap="wrap" gap={4}>
              {keyParams.map((param, idx) => (
                <ParamBadge key={idx} paramKey={param.key} value={param.value} />
              ))}
            </XStack>
          )}
        </YStack>

        {/* Expanded Details (optional) */}
        {expanded && formattedInput && (
          <YStack
            backgroundColor={colors.expandedBg}
            borderTopWidth={1}
            borderTopColor={colors.border}
            padding={12}
            gap={6}
          >
            <Text fontSize={9} color={colors.muted} fontFamily="$mono" textTransform="uppercase">
              Full Parameters
            </Text>
            <ScrollView style={{ maxHeight: 150 }} showsVerticalScrollIndicator={true}>
              <View
                style={{
                  backgroundColor: colors.surface.bgInner,
                  borderRadius: 8,
                  padding: 12,
                }}
              >
                <Text fontSize={10} color={colors.secondary} fontFamily="$mono" lineHeight={16}>
                  {formattedInput}
                </Text>
              </View>
            </ScrollView>
          </YStack>
        )}

        {/* Controls Section */}
        <XStack
          backgroundColor={colors.controlsBg}
          paddingVertical={8}
          paddingHorizontal={12}
          alignItems="center"
          justifyContent="space-between"
        >
          {/* Left: Label */}
          <XStack alignItems="center" gap={5} flex={1}>
            <Shield size={12} color={colors.purple} />
            <Text fontSize={10} color={colors.mutedLight} fontWeight="500">
              Requiere permiso
            </Text>
          </XStack>

          {/* Right: Actions */}
          <XStack gap={6} alignItems="center">
            {/* Deny button */}
            <TouchableOpacity
              onPress={() => permissionCallbacks.onDeny(permissionRequestId)}
              activeOpacity={0.7}
              style={{
                backgroundColor: colors.denyBg,
                paddingVertical: 4,
                paddingHorizontal: 10,
                borderRadius: 5,
                borderWidth: 1,
                borderColor: colors.denyBorder,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <X size={10} color={colors.denyText} />
              <Text fontSize={10} color={colors.denyText} fontWeight="500">
                Deny
              </Text>
            </TouchableOpacity>

            {/* Allow button */}
            <TouchableOpacity
              onPress={() => permissionCallbacks.onGrant(permissionRequestId)}
              activeOpacity={0.7}
              style={{
                backgroundColor: colors.allowBg,
                paddingVertical: 4,
                paddingHorizontal: 10,
                borderRadius: 5,
                borderWidth: 1,
                borderColor: colors.allowBorder,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <Check size={10} color={colors.allowText} />
              <Text fontSize={10} color={colors.allowText} fontWeight="500">
                Allow
              </Text>
            </TouchableOpacity>

            {/* Expand/More button — only shown when there are parameters to display */}
            {formattedInput && (
              <TouchableOpacity
                onPress={() => setExpanded(!expanded)}
                activeOpacity={0.7}
                style={{
                  padding: 2,
                }}
              >
                <Animated.View style={{ transform: [{ rotate: rotation }] }}>
                  <ChevronDown size={14} color={colors.muted} />
                </Animated.View>
              </TouchableOpacity>
            )}

            {/* More options (modal) */}
            <TouchableOpacity
              onPress={() => setModalVisible(true)}
              activeOpacity={0.7}
              style={{
                backgroundColor: colors.surface.border,
                paddingVertical: 6,
                paddingHorizontal: 8,
                borderRadius: 6,
              }}
            >
              <MoreVertical size={12} color={colors.secondary} />
            </TouchableOpacity>
          </XStack>
        </XStack>
      </YStack>

      {/* Modal with full options */}
      <Modal
        visible={modalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setModalVisible(false)}
      >
        <Pressable
          style={{
            flex: 1,
            backgroundColor: colors.isDark ? 'rgba(0,0,0,0.8)' : 'rgba(10,10,15,0.5)',
            justifyContent: 'center',
            alignItems: 'center',
            padding: 20,
          }}
          onPress={() => setModalVisible(false)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              backgroundColor: colors.contextBg,
              borderRadius: 16,
              borderWidth: 1,
              borderColor: colors.purpleBorder,
              width: '100%',
              maxWidth: 400,
              overflow: 'hidden',
            }}
          >
            {/* Header */}
            <YStack
              paddingHorizontal={20}
              paddingVertical={16}
              borderBottomWidth={1}
              borderBottomColor={colors.border}
              backgroundColor={semanticColors.violetGlow}
            >
              <XStack alignItems="center" gap={12}>
                <View
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 10,
                    backgroundColor: controlsBarTokens.permission.modalBorder,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Shield size={20} color={colors.purple} />
                </View>
                <YStack flex={1}>
                  <Text fontSize={17} fontWeight="600" color={colors.primary}>
                    Permiso requerido
                  </Text>
                  <Text fontSize={13} color={colors.secondary} marginTop={2}>
                    {toolName}
                  </Text>
                </YStack>
              </XStack>
            </YStack>

            {/* Command/Input details */}
            {formattedInput && (
              <YStack
                paddingHorizontal={16}
                paddingVertical={12}
                borderBottomWidth={1}
                borderBottomColor={colors.border}
              >
                <Text fontSize={11} color={colors.mutedLight} fontWeight="500" marginBottom={8}>
                  PARAMETERS
                </Text>
                <ScrollView style={{ maxHeight: 150 }} showsVerticalScrollIndicator={true}>
                  <View
                    style={{
                      backgroundColor: colors.surface.bgInner,
                      borderRadius: 8,
                      padding: 12,
                    }}
                  >
                    <Text fontSize={12} color={colors.secondary} fontFamily="$mono" lineHeight={18}>
                      {formattedInput}
                    </Text>
                  </View>
                </ScrollView>
              </YStack>
            )}

            {/* Options */}
            <YStack paddingVertical={8}>
              <MenuItem
                icon={<ShieldOff size={18} color={colors.riskHigh} />}
                label={t('permission.denyAlways')}
                description={t('permission.denyAlwaysDesc')}
                color={colors.riskHigh}
                onPress={handleDenyAlways}
              />
              <MenuItem
                icon={<X size={18} color={colors.denyText} />}
                label={t('permission.denyThis')}
                description={t('permission.denyThisDesc')}
                color={colors.denyText}
                onPress={handleDeny}
              />

              {/* Divider */}
              <View
                style={{
                  height: 1,
                  backgroundColor: colors.border,
                  marginVertical: 8,
                }}
              />

              <MenuItem
                icon={<Check size={18} color={colors.allowText} />}
                label={t('permission.allowThis')}
                description={t('permission.allowThisDesc')}
                color={colors.allowText}
                onPress={handleAllow}
              />
              <MenuItem
                icon={<ShieldCheck size={18} color={colors.riskLow} />}
                label={t('permission.allowAlways')}
                description={t('permission.allowAlwaysDesc')}
                color={colors.riskLow}
                onPress={handleAllowAlways}
              />
            </YStack>

            {/* Cancel button */}
            <TouchableOpacity
              onPress={() => setModalVisible(false)}
              activeOpacity={0.7}
              style={{
                borderTopWidth: 1,
                borderTopColor: colors.border,
                paddingVertical: 14,
                alignItems: 'center',
              }}
            >
              <Text fontSize={15} color={colors.mutedLight}>
                Cancelar
              </Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
