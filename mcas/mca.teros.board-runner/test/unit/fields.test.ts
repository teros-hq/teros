/**
 * Tests de whitelist fields del board-runner. Previenen regresiones donde
 * alguien quita un campo crítico que el renderer necesita pintar.
 */

import { describe, expect, it } from 'bun:test';
import { PROGRESS_NOTE_FIELDS, TASK_FIELDS, TASK_WITH_PROGRESS_FIELDS } from '../../src/tools/_fields';

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

  it('includes stop protocol contract (MUST be present for runners)', () => {
    expect(TASK_FIELDS).toContain('stopRequested');
    expect(TASK_FIELDS).toContain('stopRequestedAt');
    expect(TASK_FIELDS).toContain('stopRequestedBy');
  });

  it('includes derived project/assignee fields', () => {
    expect(TASK_FIELDS).toContain('projectName');
    expect(TASK_FIELDS).toContain('assigneeName');
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

describe('PROGRESS_NOTE_FIELDS', () => {
  it('includes core note fields', () => {
    expect(PROGRESS_NOTE_FIELDS).toContain('text');
    expect(PROGRESS_NOTE_FIELDS).toContain('actor');
    expect(PROGRESS_NOTE_FIELDS).toContain('timestamp');
  });
});
