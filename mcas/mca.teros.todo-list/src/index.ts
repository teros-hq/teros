#!/usr/bin/env bun

/**
 * Todo List MCA v2.1.0
 *
 * Workflowy-style hierarchical outliner — single-tree architecture.
 * No lists. Every node is part of one tree per workspace. Root nodes have parentId: null.
 * Nodes have: text, description, instructions (markdown), log (chronological history).
 *
 * Thin client. This MCA no longer holds a MongoDB connection: every tool and
 * UI resource forwards to a named backend action (`todo/<action>`) through
 * the authenticated callback, and the backend executes it against
 * `todo_nodes` with the workspace derived from the verified token
 * (datastore-isolation P1b). The tool definitions — names, parameters,
 * result shapes, the `[CODE] message suggestion` error strings — are
 * unchanged, so TodoWindow, the chat renderer and agents see exactly the
 * former contract.
 *
 * Tools:
 * - add-node: Add a node (root or nested)
 * - get-node: Get full detail of a single node (instructions + log)
 * - get-tree: Get the full nested tree (lightweight, no instructions/log)
 * - update-node: Update text, description, and/or instructions
 * - toggle-complete: Toggle completion (cascades to descendants + logs)
 * - toggle-collapse: Toggle collapse/expand
 * - move-node: Move node to different parent/position (with circular detection)
 * - delete-node: Delete a node and its entire subtree
 * - search-nodes: Search nodes by text with breadcrumb paths
 * - set-archived: Archive/unarchive a node (hidden from the default views)
 * - archive-finished: Bulk-archive finished (done/cancelled) tasks
 * - add-log-entry: Add a chronological log entry to a node
 * - set-state: Move a task between planning/pending/working/blocked/review/done
 * - set-kind: Convert a node between task and group
 * - set-progress: Report (or clear) a task's progress %
 * - set-input / set-output: Markdown, form or file (object storage) input/output
 * - toggle-instruction-item: Tick a "- [ ]" checklist item of the instructions
 * - plan-node: Plan a task for a day (order within the day, optional time)
 * - get-day: One day of the plan + overdue and unplanned open tasks
 * - assign-node: Assign a task to an agent or a workspace member (or unassign)
 *
 * UI Resources:
 * - tree: Full tree view (collapsible/expandable hierarchy)
 * - detail: Node detail panel (instructions + log)
 * - form: Add/edit node form
 *
 * Events:
 * - node.added, node.updated, node.completed, node.moved, node.deleted,
 *   node.state, node.progress, node.output
 */

import { McaServer, loadEventsDeclaration, registerSubscriptionTools } from '@teros/mca-sdk';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { TODO_EVENTS } from './events';
import { TOOLS } from './tools';
import { detailResource, formResource, treeResource } from './ui';

const server = new McaServer({
  id: 'mca.teros.todo-list',
  name: 'Todo List',
  version: '2.1.0',
});

// ---------------------------------------------------------------------------
// Tools (see ./tools.ts — every handler forwards to a backend action)
// ---------------------------------------------------------------------------

for (const [name, tool] of Object.entries(TOOLS)) {
  server.tool(name, tool);
}

// ---------------------------------------------------------------------------
// Reserved subscription tools (v1.4.4 — the unified subscription API).
// todo_list__subscribe(event: 'task_completed', filter?) → backend topic
// todo.task_completed. Replaces subscribe-to-todo (deprecated, still
// functional). State lives in the backend: subscriptions survive respawns.
// ---------------------------------------------------------------------------

registerSubscriptionTools(server, loadEventsDeclaration(dirname(fileURLToPath(import.meta.url))));

// ---------------------------------------------------------------------------
// UI Resources — declarative renderable components
// ---------------------------------------------------------------------------

server.ui('tree', treeResource);
server.ui('detail', detailResource);
server.ui('form', formResource);

// ---------------------------------------------------------------------------
// Events — declared statically via TODO_EVENTS and emitted from tool handlers
// via emitEvent(). The host discovers them from the manifest.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await server.start();
  console.error(
    `Todo List MCA v2.1.0 running (thin client — backend actions todo/*) — ` +
    `${TODO_EVENTS.length} events, 3 UI resources`,
  );
}

main().catch((error) => {
  console.error('[Todo List MCA] Fatal error:', error);
  process.exit(1);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
