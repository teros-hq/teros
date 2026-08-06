/**
 * Tests de whitelist fields: garantizan que los campos críticos que el
 * renderer frontend necesita pintar están presentes en las whitelists.
 *
 * Gotcha aprendido en Core: `APP_FIELDS` olvidó `icon`/`color` y el renderer
 * pintaba iniciales. Estos tests protegen contra regresiones similares en
 * `TASK_FIELDS` / `PROJECT_FIELDS` / etc.
 */

import { describe, expect, it } from 'bun:test';
import {
  AGENT_PROJECT_RELATIONSHIP_FIELDS,
  BOARD_AGENT_FIELDS,
  BOARD_COLUMN_FIELDS,
  BOARD_STATUS_AGENT_FIELDS,
  BOARD_SUBSCRIPTION_FIELDS,
  PROGRESS_NOTE_FIELDS,
  PROJECT_FIELDS,
  TASK_DEPENDENCY_FIELDS,
  TASK_FIELDS,
  TASK_WITH_PROGRESS_FIELDS,
} from '../../src/tools/_fields';

describe('TASK_FIELDS', () => {
  it('includes identifiers', () => {
    expect(TASK_FIELDS).toContain('taskId');
    expect(TASK_FIELDS).toContain('boardId');
    expect(TASK_FIELDS).toContain('columnId');
  });

  it('includes derived column fields (backend enrichment contract)', () => {
    expect(TASK_FIELDS).toContain('columnName');
    expect(TASK_FIELDS).toContain('columnSlug');
  });

  it('includes visual/renderer-critical fields', () => {
    expect(TASK_FIELDS).toContain('title');
    expect(TASK_FIELDS).toContain('priority');
    expect(TASK_FIELDS).toContain('archived');
    expect(TASK_FIELDS).toContain('tags');
    expect(TASK_FIELDS).toContain('running');
    expect(TASK_FIELDS).toContain('assignedAgentId');
  });

  it('includes stop protocol contract', () => {
    expect(TASK_FIELDS).toContain('stopRequested');
  });

  it('includes derived agent fields for assignee rendering', () => {
    expect(TASK_FIELDS).toContain('assigneeName');
    expect(TASK_FIELDS).toContain('assigneeAvatarUrl');
  });

  it('includes timestamps', () => {
    expect(TASK_FIELDS).toContain('createdAt');
    expect(TASK_FIELDS).toContain('updatedAt');
  });
});

describe('TASK_WITH_PROGRESS_FIELDS', () => {
  it('is a superset of TASK_FIELDS', () => {
    for (const field of TASK_FIELDS) {
      expect(TASK_WITH_PROGRESS_FIELDS).toContain(field);
    }
  });

  it('adds progressNotes', () => {
    expect(TASK_WITH_PROGRESS_FIELDS).toContain('progressNotes');
  });
});

describe('PROJECT_FIELDS', () => {
  it('includes identifiers and name', () => {
    expect(PROJECT_FIELDS).toContain('projectId');
    expect(PROJECT_FIELDS).toContain('workspaceId');
    expect(PROJECT_FIELDS).toContain('boardId');
    expect(PROJECT_FIELDS).toContain('name');
  });

  it('includes derived stats (list-projects enrichment)', () => {
    expect(PROJECT_FIELDS).toContain('taskCount');
    expect(PROJECT_FIELDS).toContain('activeAgentCount');
  });

  it('includes status for filtering', () => {
    expect(PROJECT_FIELDS).toContain('status');
  });
});

describe('BOARD_COLUMN_FIELDS', () => {
  it('includes slug (needed by TaskStatusBadge renderer)', () => {
    expect(BOARD_COLUMN_FIELDS).toContain('slug');
    expect(BOARD_COLUMN_FIELDS).toContain('name');
    expect(BOARD_COLUMN_FIELDS).toContain('columnId');
  });
});

describe('BOARD_AGENT_FIELDS', () => {
  it('includes visual fields (avatarUrl, name)', () => {
    expect(BOARD_AGENT_FIELDS).toContain('agentId');
    expect(BOARD_AGENT_FIELDS).toContain('name');
    expect(BOARD_AGENT_FIELDS).toContain('avatarUrl');
  });
});

describe('AGENT_PROJECT_RELATIONSHIP_FIELDS', () => {
  it('includes autoplay control fields', () => {
    expect(AGENT_PROJECT_RELATIONSHIP_FIELDS).toContain('slots');
    expect(AGENT_PROJECT_RELATIONSHIP_FIELDS).toContain('playEnabled');
  });
});

describe('BOARD_STATUS_AGENT_FIELDS', () => {
  it('includes workload fields', () => {
    expect(BOARD_STATUS_AGENT_FIELDS).toContain('tasksInReview');
    expect(BOARD_STATUS_AGENT_FIELDS).toContain('tasksBlocked');
  });
});

describe('BOARD_SUBSCRIPTION_FIELDS', () => {
  it('includes subscription identifiers and filter', () => {
    expect(BOARD_SUBSCRIPTION_FIELDS).toContain('subscriptionId');
    expect(BOARD_SUBSCRIPTION_FIELDS).toContain('boardId');
    expect(BOARD_SUBSCRIPTION_FIELDS).toContain('filter');
  });
});

describe('TASK_DEPENDENCY_FIELDS', () => {
  it('is compact (avoid spam in dependency chips)', () => {
    expect(TASK_DEPENDENCY_FIELDS.length).toBeLessThanOrEqual(6);
    expect(TASK_DEPENDENCY_FIELDS).toContain('taskId');
    expect(TASK_DEPENDENCY_FIELDS).toContain('title');
  });
});

describe('PROGRESS_NOTE_FIELDS', () => {
  it('includes core note fields', () => {
    expect(PROGRESS_NOTE_FIELDS).toContain('text');
    expect(PROGRESS_NOTE_FIELDS).toContain('actor');
    expect(PROGRESS_NOTE_FIELDS).toContain('timestamp');
  });
});
