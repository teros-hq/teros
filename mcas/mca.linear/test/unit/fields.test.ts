import { describe, expect, it } from 'bun:test';
import {
  COMMENT_FIELDS,
  CYCLE_FIELDS,
  ISSUE_COMPACT_FIELDS,
  ISSUE_DETAIL_FIELDS,
  LABEL_FIELDS,
  PROJECT_COMPACT_FIELDS,
  PROJECT_DETAIL_FIELDS,
  TEAM_FIELDS,
  USER_FIELDS,
  WORKFLOW_STATE_FIELDS,
} from '../../src/tools/_fields';

// Regression: the renderer falls back to initials / placeholders when visual
// fields are missing from the whitelist. These asserts catch accidental
// narrowing by future edits.
describe('_fields whitelists', () => {
  it('ISSUE_COMPACT_FIELDS keeps identity + navigation + triage', () => {
    expect(ISSUE_COMPACT_FIELDS).toContain('id');
    expect(ISSUE_COMPACT_FIELDS).toContain('identifier');
    expect(ISSUE_COMPACT_FIELDS).toContain('title');
    expect(ISSUE_COMPACT_FIELDS).toContain('url');
    expect(ISSUE_COMPACT_FIELDS).toContain('status');
    expect(ISSUE_COMPACT_FIELDS).toContain('priority');
    expect(ISSUE_COMPACT_FIELDS).toContain('assignee');
    expect(ISSUE_COMPACT_FIELDS).toContain('team');
  });

  it('ISSUE_DETAIL_FIELDS extends compact with description + labels + relations', () => {
    for (const key of ISSUE_COMPACT_FIELDS) {
      expect(ISSUE_DETAIL_FIELDS).toContain(key);
    }
    expect(ISSUE_DETAIL_FIELDS).toContain('description');
    expect(ISSUE_DETAIL_FIELDS).toContain('labels');
    expect(ISSUE_DETAIL_FIELDS).toContain('project');
    expect(ISSUE_DETAIL_FIELDS).toContain('cycle');
  });

  it('PROJECT_COMPACT_FIELDS keeps visual icon + color + url', () => {
    expect(PROJECT_COMPACT_FIELDS).toContain('id');
    expect(PROJECT_COMPACT_FIELDS).toContain('name');
    expect(PROJECT_COMPACT_FIELDS).toContain('url');
    expect(PROJECT_COMPACT_FIELDS).toContain('icon');
    expect(PROJECT_COMPACT_FIELDS).toContain('color');
    expect(PROJECT_COMPACT_FIELDS).toContain('state');
  });

  it('PROJECT_DETAIL_FIELDS adds description + lead + teams', () => {
    for (const key of PROJECT_COMPACT_FIELDS) {
      expect(PROJECT_DETAIL_FIELDS).toContain(key);
    }
    expect(PROJECT_DETAIL_FIELDS).toContain('description');
    expect(PROJECT_DETAIL_FIELDS).toContain('lead');
    expect(PROJECT_DETAIL_FIELDS).toContain('teams');
  });

  it('USER_FIELDS keeps avatarUrl (renderer falls back to initials otherwise)', () => {
    expect(USER_FIELDS).toContain('id');
    expect(USER_FIELDS).toContain('name');
    expect(USER_FIELDS).toContain('avatarUrl');
    expect(USER_FIELDS).toContain('email');
  });

  it('TEAM_FIELDS keeps icon + color + key', () => {
    expect(TEAM_FIELDS).toContain('id');
    expect(TEAM_FIELDS).toContain('name');
    expect(TEAM_FIELDS).toContain('key');
    expect(TEAM_FIELDS).toContain('icon');
    expect(TEAM_FIELDS).toContain('color');
  });

  it('LABEL_FIELDS keeps color (the whole point of a label)', () => {
    expect(LABEL_FIELDS).toContain('id');
    expect(LABEL_FIELDS).toContain('name');
    expect(LABEL_FIELDS).toContain('color');
  });

  it('WORKFLOW_STATE_FIELDS keeps type + color + position', () => {
    expect(WORKFLOW_STATE_FIELDS).toContain('id');
    expect(WORKFLOW_STATE_FIELDS).toContain('name');
    expect(WORKFLOW_STATE_FIELDS).toContain('type');
    expect(WORKFLOW_STATE_FIELDS).toContain('color');
    expect(WORKFLOW_STATE_FIELDS).toContain('position');
  });

  it('CYCLE_FIELDS keeps number + dates', () => {
    expect(CYCLE_FIELDS).toContain('id');
    expect(CYCLE_FIELDS).toContain('number');
    expect(CYCLE_FIELDS).toContain('startsAt');
    expect(CYCLE_FIELDS).toContain('endsAt');
  });

  it('COMMENT_FIELDS collapses to plain body and does not leak reactions', () => {
    expect(COMMENT_FIELDS).toContain('id');
    expect(COMMENT_FIELDS).toContain('body');
    expect(COMMENT_FIELDS).toContain('authorId');
    expect(COMMENT_FIELDS).toContain('issueId');
    expect(COMMENT_FIELDS).not.toContain('reactions');
  });
});
