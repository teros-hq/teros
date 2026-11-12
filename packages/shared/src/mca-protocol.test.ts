/**
 * Contract — isProgressNoteTool() recognises the progress-note tools that pass
 * the maxSteps block and reset the step counter: the board's
 * `add-progress-note` and the To Do app's `add-log-entry` + `set-progress`
 * (TODOAP-REQ-19), called directly, through the `execute-tool` proxy, or in
 * the flat tool-call format (`todo_list_add_log_entry` — hyphens sanitized to
 * underscores by agent-proxy-flat-tools.ts; bug 2026-10-30).
 */
import { describe, it, expect } from 'bun:test';
import {
  isProgressNoteTool,
  isTaskCompletionTool,
  findProgressNoteToolName,
  findTaskCompletionToolNames,
  PROGRESS_NOTE_TOOL_NAMES,
  TASK_COMPLETION_TOOL_NAMES,
} from './mca-protocol';

describe('isProgressNoteTool', () => {
  it('[TODOAP-AC-24] add-log-entry is a progress-note tool, directly and through execute-tool; set-state is not', () => {
    expect(PROGRESS_NOTE_TOOL_NAMES).toContain('add-log-entry');
    expect(isProgressNoteTool('todo-list_add-log-entry')).toBe(true);
    expect(isProgressNoteTool('execute-tool', { app: 'todo-list', tool: 'add-log-entry', input: {} })).toBe(true);
    expect(isProgressNoteTool('todo-list_set-state')).toBe(false);
    expect(isProgressNoteTool('execute-tool', { app: 'todo-list', tool: 'set-state', input: {} })).toBe(false);
  });

  it('keeps recognising the board add-progress-note, directly and through execute-tool', () => {
    expect(isProgressNoteTool('board-runner_add-progress-note')).toBe(true);
    expect(isProgressNoteTool('execute-tool', { app: 'board-runner', tool: 'add-progress-note' })).toBe(true);
    expect(isProgressNoteTool('execute-tool')).toBe(false);
  });

  // ---- flat tool-call format: separators sanitized to underscores (2026-10-30 bug) ----

  it('recognises the flat-format names (underscores) of every progress-note tool', () => {
    expect(isProgressNoteTool('todo_list_add_log_entry')).toBe(true);
    expect(isProgressNoteTool('board_runner_add_progress_note')).toBe(true);
    expect(isProgressNoteTool('todo_list_set_progress')).toBe(true);
    // The non-note neighbours stay out, in both formats
    expect(isProgressNoteTool('todo_list_set_state')).toBe(false);
    expect(isProgressNoteTool('todo_list_set_output')).toBe(false);
    expect(isProgressNoteTool('board_runner_move_task')).toBe(false);
  });

  it('set-progress is a progress-note tool (decision TODOAP-REQ-19 follow-up): direct, proxied and flat', () => {
    expect(PROGRESS_NOTE_TOOL_NAMES).toContain('set-progress');
    expect(isProgressNoteTool('todo-list_set-progress')).toBe(true);
    expect(isProgressNoteTool('execute-tool', { app: 'todo-list', tool: 'set-progress', input: {} })).toBe(true);
  });

  it('an unrelated underscore name cannot smuggle a match (no false positives from normalization)', () => {
    // 'add-log-entries' (plural) does not contain 'add-log-entry'
    expect(isProgressNoteTool('todo_list_add_log_entries_archive')).toBe(false);
    // 'export-progress-settings' does not contain 'set-progress'
    expect(isProgressNoteTool('export_progress_settings')).toBe(false);
  });
});

describe('findProgressNoteToolName', () => {
  it('finds the canonical note tool in a namespaced toolset', () => {
    expect(findProgressNoteToolName(['todo-list_set-state', 'todo-list_add-log-entry'])).toBe('add-log-entry');
    expect(findProgressNoteToolName(['board-runner_add-progress-note'])).toBe('add-progress-note');
  });

  it('finds the canonical note tool in a flat (underscore) toolset — the 2026-10-30 bug', () => {
    // Before the fix this returned null → the block message fell back to the
    // conversational variant and never told the runner about the reset valve.
    expect(findProgressNoteToolName(['todo_list_set_state', 'todo_list_add_log_entry'])).toBe('add-log-entry');
    expect(findProgressNoteToolName(['board_runner_add_progress_note'])).toBe('add-progress-note');
  });

  it('returns null when the agent has no progress-note tool (conversational agents)', () => {
    expect(findProgressNoteToolName(['search', 'write_file'])).toBeNull();
    expect(findProgressNoteToolName([])).toBeNull();
  });
});

// ---- task-completion tools (2026-11-02): pass the maxSteps block, no reset ----

describe('isTaskCompletionTool', () => {
  it('recognises set-output and set-state, directly and through execute-tool', () => {
    expect(TASK_COMPLETION_TOOL_NAMES).toContain('set-output');
    expect(TASK_COMPLETION_TOOL_NAMES).toContain('set-state');
    expect(isTaskCompletionTool('todo-list_set-output')).toBe(true);
    expect(isTaskCompletionTool('todo-list_set-state')).toBe(true);
    expect(isTaskCompletionTool('execute-tool', { app: 'todo-list', tool: 'set-output', input: {} })).toBe(true);
    expect(isTaskCompletionTool('execute-tool', { app: 'todo-list', tool: 'set-state', input: {} })).toBe(true);
  });

  it('recognises the board runner completion tools, directly and proxied', () => {
    expect(TASK_COMPLETION_TOOL_NAMES).toContain('complete-my-task');
    expect(TASK_COMPLETION_TOOL_NAMES).toContain('block-my-task');
    expect(isTaskCompletionTool('board-runner_complete-my-task')).toBe(true);
    expect(isTaskCompletionTool('board-runner_block-my-task')).toBe(true);
    expect(isTaskCompletionTool('execute-tool', { app: 'board-runner', tool: 'complete-my-task' })).toBe(true);
  });

  it('recognises the flat-format (underscore) names of every completion tool', () => {
    expect(isTaskCompletionTool('todo_list_set_output')).toBe(true);
    expect(isTaskCompletionTool('todo_list_set_state')).toBe(true);
    expect(isTaskCompletionTool('board_runner_complete_my_task')).toBe(true);
    expect(isTaskCompletionTool('board_runner_block_my_task')).toBe(true);
  });

  it('keeps the neighbours out: progress-note tools are NOT completion tools and vice versa', () => {
    // add-log-entry resets the counter; set-output does not. The two
    // whitelists are deliberately disjoint.
    expect(isTaskCompletionTool('todo-list_add-log-entry')).toBe(false);
    expect(isTaskCompletionTool('todo-list_set-progress')).toBe(false);
    expect(isProgressNoteTool('todo-list_set-output')).toBe(false);
    expect(isProgressNoteTool('todo-list_set-state')).toBe(false);
    expect(isTaskCompletionTool('execute-tool')).toBe(false);
    expect(isTaskCompletionTool('search')).toBe(false);
  });

  it('an unrelated underscore name cannot smuggle a match (no false positives from normalization)', () => {
    // 'output-settings' does not contain 'set-output' (note: 'reset-output-settings' WOULD —
    // substring matching is the established semantics, same as isProgressNoteTool;
    // the catalog scan (2026-11-02) confirmed no real collisions in mcas/*/tools.json)
    expect(isTaskCompletionTool('output_settings')).toBe(false);
    expect(isTaskCompletionTool('get_output')).toBe(false);
    // 'get-state-info' does not contain 'set-state'
    expect(isTaskCompletionTool('get_state_info')).toBe(false);
    expect(isTaskCompletionTool('get_my_tasks')).toBe(false);
  });
});

describe('findTaskCompletionToolNames', () => {
  it('returns the To Do runner tools in canonical order (set-output before set-state)', () => {
    expect(
      findTaskCompletionToolNames(['todo-list_set-state', 'todo-list_set-output', 'todo-list_add-log-entry']),
    ).toEqual(['set-output', 'set-state']);
  });

  it('returns the board runner tools in canonical order', () => {
    expect(
      findTaskCompletionToolNames(['board-runner_block-my-task', 'board-runner_complete-my-task']),
    ).toEqual(['complete-my-task', 'block-my-task']);
  });

  it('finds the tools in a flat (underscore) toolset', () => {
    expect(
      findTaskCompletionToolNames(['todo_list_set_output', 'todo_list_set_state']),
    ).toEqual(['set-output', 'set-state']);
  });

  it('returns an empty array for conversational agents with no completion tools', () => {
    expect(findTaskCompletionToolNames(['search', 'write_file'])).toEqual([]);
    expect(findTaskCompletionToolNames([])).toEqual([]);
  });
});
