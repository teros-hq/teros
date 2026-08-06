import { describe, expect, it } from 'bun:test';
import {
  cleanOptionalString,
  extractCommentShape,
  extractIssueShape,
  extractLabel,
  extractPriority,
  extractProjectShape,
  extractState,
  extractTeam,
  extractUser,
  extractWorkflowState,
  isUuid,
  NUMBER_TO_PRIORITY,
  PRIORITY_TO_NUMBER,
  validateIssueId,
  validateUuid,
} from '../../src/tools/_linear-helpers';
import { pickFields, resolveFields, sanitiseBody, sanitizeLimit } from '../../src/tools/utils';

const UUID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const UUID_UNDASHED = 'f47ac10b58cc4372a5670e02b2c3d479';

describe('validateUuid / validateIssueId', () => {
  it('accepts valid UUID with dashes', () => {
    expect(validateUuid(UUID, 'x')).toBe(UUID);
  });

  it('accepts undashed UUIDs (Linear canonicalises)', () => {
    expect(validateUuid(UUID_UNDASHED, 'x')).toBe(UUID_UNDASHED);
  });

  it('rejects garbage', () => {
    expect(() => validateUuid('not-a-uuid', 'x')).toThrow();
    expect(() => validateUuid('', 'x')).toThrow();
  });

  it('validateIssueId accepts UUID and "TEAM-123" identifier', () => {
    expect(validateIssueId(UUID)).toBe(UUID);
    expect(validateIssueId('TER-123')).toBe('TER-123');
    expect(validateIssueId('ENG-4567')).toBe('ENG-4567');
  });

  it('validateIssueId rejects lowercase or malformed identifiers', () => {
    expect(() => validateIssueId('ter-123')).toThrow();
    expect(() => validateIssueId('TER')).toThrow();
    expect(() => validateIssueId('TER-abc')).toThrow();
  });

  it('isUuid distinguishes UUID from identifier', () => {
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid(UUID_UNDASHED)).toBe(true);
    expect(isUuid('TER-123')).toBe(false);
    expect(isUuid('not-a-uuid')).toBe(false);
  });
});

describe('cleanOptionalString', () => {
  it('returns the trimmed string when non-empty', () => {
    expect(cleanOptionalString('hello')).toBe('hello');
    expect(cleanOptionalString('  TER-123  ')).toBe('TER-123');
  });

  it('returns undefined for empty/whitespace strings', () => {
    expect(cleanOptionalString('')).toBeUndefined();
    expect(cleanOptionalString('   ')).toBeUndefined();
    expect(cleanOptionalString('\t\n')).toBeUndefined();
  });

  it('returns undefined for non-string inputs', () => {
    expect(cleanOptionalString(undefined)).toBeUndefined();
    expect(cleanOptionalString(null)).toBeUndefined();
    expect(cleanOptionalString(0)).toBeUndefined();
    expect(cleanOptionalString({})).toBeUndefined();
  });
});

describe('extractPriority', () => {
  it('maps numbers to named priorities', () => {
    expect(extractPriority(0)).toEqual({ number: 0, name: 'none' });
    expect(extractPriority(1)).toEqual({ number: 1, name: 'urgent' });
    expect(extractPriority(4)).toEqual({ number: 4, name: 'low' });
  });

  it('defaults to none for non-numbers', () => {
    expect(extractPriority(undefined)).toEqual({ number: 0, name: 'none' });
    expect(extractPriority('urgent' as any)).toEqual({ number: 0, name: 'none' });
  });

  it('round-trips via PRIORITY_TO_NUMBER', () => {
    for (const [name, n] of Object.entries(PRIORITY_TO_NUMBER)) {
      expect(NUMBER_TO_PRIORITY[n]).toBe(name);
    }
  });
});

describe('extract relation helpers', () => {
  it('extractUser keeps avatarUrl and email', () => {
    const raw = {
      id: 'u1',
      name: 'Alice',
      displayName: 'a',
      email: 'a@example.com',
      avatarUrl: 'https://cdn.linear.app/avatars/a.png',
      active: true,
      admin: false,
    };
    const u = extractUser(raw);
    expect(u).toMatchObject({
      id: 'u1',
      name: 'Alice',
      email: 'a@example.com',
      avatarUrl: 'https://cdn.linear.app/avatars/a.png',
    });
  });

  it('extractTeam keeps icon + color + key', () => {
    const raw = { id: 't1', name: 'Teros', key: 'TER', icon: '🔷', color: '#5E6AD2' };
    const t = extractTeam(raw);
    expect(t).toMatchObject({ id: 't1', name: 'Teros', key: 'TER', icon: '🔷', color: '#5E6AD2' });
  });

  it('extractLabel passes through parentId when present', () => {
    const raw = { id: 'l1', name: 'bug', color: '#ff0000', parent: { id: 'group1' } };
    const l = extractLabel(raw);
    expect(l?.parentId).toBe('group1');
    expect(l?.color).toBe('#ff0000');
  });

  it('extractState returns name-only shape', () => {
    expect(extractState({ name: 'In Progress', type: 'started' })).toEqual({
      name: 'In Progress',
      type: 'started',
    });
    expect(extractState(null)).toBe(null);
    expect(extractState({})).toBe(null);
  });

  it('extractWorkflowState passes position through', () => {
    const raw = { id: 's1', name: 'Todo', type: 'unstarted', color: '#aaaaaa', position: 0.5 };
    const s = extractWorkflowState(raw);
    expect(s?.position).toBe(0.5);
    expect(s?.type).toBe('unstarted');
  });
});

describe('extractIssueShape', () => {
  it('collapses relations into minimal refs', () => {
    const raw = {
      id: 'i1',
      identifier: 'TER-1',
      title: 'Foo',
      url: 'https://linear.app/team/issue/TER-1',
      description: '# hello',
      priority: 2,
      dueDate: '2026-05-01',
      estimate: 3,
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-10T00:00:00.000Z',
    };
    const shape = extractIssueShape(raw, {
      state: { name: 'In Progress', type: 'started' },
      assignee: { id: 'u1', name: 'Alice' },
      team: { id: 't1', name: 'Teros', key: 'TER' },
      project: { id: 'p1', name: 'Alpha', state: 'started' },
      cycle: { id: 'c1', name: 'Cycle 1', number: 1 },
      labelNodes: [
        { id: 'l1', name: 'bug' },
        { id: 'l2', name: 'urgent' },
      ],
    });
    expect(shape.status).toBe('In Progress');
    expect(shape.priority).toEqual({ number: 2, name: 'high' });
    expect(shape.labels).toEqual(['bug', 'urgent']);
    expect(shape.assignee?.name).toBe('Alice');
    expect(shape.team?.key).toBe('TER');
    expect(shape.project?.name).toBe('Alpha');
    expect(shape.cycle?.number).toBe(1);
    expect(shape.dueDate).toBe('2026-05-01');
    expect(shape.estimate).toBe(3);
  });

  it('degrades gracefully with missing relations', () => {
    const shape = extractIssueShape(
      { id: 'i1', identifier: 'TER-2', title: 't', url: 'u', priority: 0, createdAt: '', updatedAt: '' },
      {},
    );
    expect(shape.status).toBe(null);
    expect(shape.assignee).toBe(null);
    expect(shape.labels).toEqual([]);
    expect(shape.project).toBe(null);
    expect(shape.cycle).toBe(null);
  });
});

describe('extractProjectShape', () => {
  it('builds shape from raw + resolved lead + teams', () => {
    const shape = extractProjectShape(
      {
        id: 'p1',
        name: 'Alpha',
        url: 'https://linear.app/team/project/alpha',
        description: '',
        state: 'started',
        progress: 0.42,
        startDate: '2026-04-01',
        targetDate: '2026-05-01',
        createdAt: '2026-04-01T00:00:00Z',
        updatedAt: '2026-04-10T00:00:00Z',
        icon: null,
        color: '#5E6AD2',
      },
      {
        lead: { id: 'u1', name: 'Alice' },
        teamNodes: [
          { id: 't1', name: 'Teros' },
          { id: 't2', name: 'Backend' },
        ],
      },
    );
    expect(shape.lead?.name).toBe('Alice');
    expect(shape.teams).toHaveLength(2);
    expect(shape.teams[0]).toEqual({ id: 't1', name: 'Teros' });
    expect(shape.progress).toBe(0.42);
  });
});

describe('extractCommentShape', () => {
  it('passes body through and resolves author + issue', () => {
    const shape = extractCommentShape(
      {
        id: 'c1',
        body: 'looks good',
        url: 'https://linear.app/c/1',
        createdAt: '2026-04-01T00:00:00Z',
        updatedAt: '2026-04-01T00:00:00Z',
      },
      { user: { id: 'u1', name: 'Alice' }, issue: { id: 'i1' } },
    );
    expect(shape.body).toBe('looks good');
    expect(shape.authorId).toBe('u1');
    expect(shape.authorName).toBe('Alice');
    expect(shape.issueId).toBe('i1');
  });
});

describe('pickFields / resolveFields', () => {
  it('pickFields keeps only whitelisted keys', () => {
    const obj = { a: 1, b: 2, c: 3 };
    expect(pickFields(obj, ['a', 'c'])).toEqual({ a: 1, c: 3 });
  });

  it('resolveFields returns raw when includeRaw=true', () => {
    const raw = { _raw: true };
    const shape = { a: 1, b: 2 };
    expect(resolveFields(shape, raw, { includeRaw: true, defaultFields: ['a'] })).toEqual(raw);
  });

  it('resolveFields uses fields override when provided', () => {
    const shape = { a: 1, b: 2, c: 3 };
    expect(
      resolveFields(shape, shape, { fields: ['b'], defaultFields: ['a', 'b', 'c'] }),
    ).toEqual({ b: 2 });
  });

  it('resolveFields falls back to defaultFields', () => {
    const shape = { a: 1, b: 2 };
    expect(resolveFields(shape, shape, { defaultFields: ['a'] })).toEqual({ a: 1 });
  });
});

describe('sanitizeLimit', () => {
  it('clamps within [min, max] and floors decimals', () => {
    expect(sanitizeLimit(10, { max: 100, default: 50 })).toBe(10);
    expect(sanitizeLimit(10.7, { max: 100, default: 50 })).toBe(10);
    expect(sanitizeLimit(1000, { max: 100, default: 50 })).toBe(100);
    expect(sanitizeLimit(-5, { max: 100, default: 50 })).toBe(1);
    expect(sanitizeLimit('bad' as any, { max: 100, default: 50 })).toBe(50);
    expect(sanitizeLimit(undefined, { max: 100, default: 50 })).toBe(50);
  });
});

describe('sanitiseBody', () => {
  it('strips undefined but keeps null by default', () => {
    expect(sanitiseBody({ a: 1, b: undefined, c: null })).toEqual({ a: 1, c: null });
  });

  it('strips null when opted in', () => {
    expect(sanitiseBody({ a: 1, b: undefined, c: null }, { stripNull: true })).toEqual({ a: 1 });
  });
});
