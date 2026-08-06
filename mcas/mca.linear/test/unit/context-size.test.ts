/**
 * Regression test for the TER-280 audit goal: mca.linear responses must
 * not destroy the agent's context window.
 *
 * Simulates a realistic list-issues response (50 rows, typical relations
 * present — assignee, state, team, project, cycle, labels, description) and
 * compares the raw SDK-like payload against the curated `buildIssueListShape`
 * filtered through ISSUE_COMPACT_FIELDS.
 *
 * Target: curated ≤ 40 % of raw (reduction ≥ 60 %). The measured number is
 * logged so it can be lifted into the assessment doc.
 */

import { describe, expect, it } from 'bun:test';
import { ISSUE_COMPACT_FIELDS, PROJECT_COMPACT_FIELDS } from '../../src/tools/_fields';
import { extractIssueShape, extractProjectShape, slimTeam, slimUser } from '../../src/tools/_linear-helpers';
import { pickFieldsList } from '../../src/tools/utils';

function makeIssueRaw(i: number) {
  return {
    id: `ter-issue-${String(i).padStart(6, '0')}-uuid-0000`,
    identifier: `TER-${i}`,
    title: `Task ${i}: review the quarterly roadmap proposal`,
    url: `https://linear.app/teros/issue/TER-${i}/task-${i}`,
    description:
      'This is a longer markdown description with plenty of filler text so the response ' +
      'has a realistic verbose payload similar to production. It includes checklists, links, ' +
      'and several paragraphs of context so that the size measurement is meaningful.',
    priority: (i % 5) as 0 | 1 | 2 | 3 | 4,
    estimate: i % 4 === 0 ? i : null,
    dueDate: i % 3 === 0 ? '2026-05-01' : null,
    createdAt: new Date(2026, 3, 1, 12, 0, 0).toISOString(),
    updatedAt: new Date(2026, 3, 10, 15, 30, 0).toISOString(),
    archivedAt: null,
    parent: null,
    // Nested relations that the SDK would serialise into JSON when includeRaw=true.
    // We embed representative verbosity (not exhaustive GraphQL metadata but
    // close to what the Linear JS SDK hydrates on an Issue node).
    state: {
      id: `state-${i % 5}-uuid`,
      name: ['Backlog', 'Todo', 'In Progress', 'In Review', 'Done'][i % 5],
      type: ['backlog', 'unstarted', 'started', 'started', 'completed'][i % 5],
      color: '#aabbcc',
      position: i % 5,
      description: null,
    },
    assignee: {
      id: `user-${i % 7}-uuid`,
      name: `Alice ${i % 7}`,
      displayName: `alice${i % 7}`,
      email: `alice${i % 7}@example.com`,
      avatarUrl: `https://cdn.linear.app/avatars/${i % 7}.png`,
      active: true,
      admin: false,
    },
    creator: {
      id: 'creator-uuid',
      name: 'Bot',
      email: 'bot@example.com',
      avatarUrl: 'https://cdn.linear.app/avatars/bot.png',
    },
    team: {
      id: 'team-teros-uuid',
      name: 'Teros',
      key: 'TER',
      icon: '🔷',
      color: '#5E6AD2',
      description: 'Teros engineering',
      private: false,
    },
    project:
      i % 2 === 0
        ? {
            id: `project-${i % 3}-uuid`,
            name: `Project Alpha ${i % 3}`,
            state: 'started',
            icon: null,
            color: '#FF5733',
            description: 'Quarterly roadmap project',
            progress: 0.4,
            startDate: '2026-04-01',
            targetDate: '2026-07-01',
          }
        : null,
    cycle:
      i % 4 === 0
        ? {
            id: `cycle-${i % 5}-uuid`,
            name: `Sprint ${i % 5}`,
            number: i % 10,
            startsAt: '2026-04-15',
            endsAt: '2026-04-29',
          }
        : null,
    labelsList: [
      { id: `lbl-${i % 3}`, name: ['bug', 'feature', 'chore'][i % 3], color: '#ff0000', description: null },
      { id: `lbl-${(i + 1) % 3}`, name: ['docs', 'ops', 'ui'][(i + 1) % 3], color: '#00ff00', description: null },
    ],
  };
}

describe('context-size regression — list-issues', () => {
  it('curated default is ≥ 60 % smaller than raw', () => {
    const rawIssues = Array.from({ length: 50 }, (_, i) => makeIssueRaw(i));
    // Mirror what `buildIssueListShape` does at runtime: slim user + team
    // relations to the minimum fields a list row needs.
    const shaped = rawIssues.map((raw) =>
      extractIssueShape(raw, {
        state: raw.state,
        assignee: slimUser(raw.assignee),
        team: slimTeam(raw.team),
      }),
    );
    const curated = pickFieldsList(shaped as any, [...ISSUE_COMPACT_FIELDS]);

    const rawSize = JSON.stringify(rawIssues).length;
    const curatedSize = JSON.stringify(curated).length;
    const ratio = curatedSize / rawSize;

    // biome-ignore lint/suspicious/noConsoleLog: regression output is lifted into the audit doc
    console.log(
      `[context-size] list-issues raw=${rawSize}B curated=${curatedSize}B ratio=${ratio.toFixed(
        3,
      )} reduction=${((1 - ratio) * 100).toFixed(1)}%`,
    );

    expect(ratio).toBeLessThanOrEqual(0.4);
  });

  it('curated with fields=["identifier","title","status"] is even smaller', () => {
    const rawIssues = Array.from({ length: 50 }, (_, i) => makeIssueRaw(i));
    const shaped = rawIssues.map((raw) =>
      extractIssueShape(raw, {
        state: raw.state,
        assignee: slimUser(raw.assignee),
        team: slimTeam(raw.team),
      }),
    );
    const curated = pickFieldsList(shaped as any, ['identifier', 'title', 'status']);

    const rawSize = JSON.stringify(rawIssues).length;
    const curatedSize = JSON.stringify(curated).length;
    const ratio = curatedSize / rawSize;

    // biome-ignore lint/suspicious/noConsoleLog: regression output is lifted into the audit doc
    console.log(
      `[context-size] list-issues whitelist=["identifier","title","status"] raw=${rawSize}B curated=${curatedSize}B ratio=${ratio.toFixed(
        3,
      )} reduction=${((1 - ratio) * 100).toFixed(1)}%`,
    );

    expect(ratio).toBeLessThanOrEqual(0.12);
  });
});

function makeProjectRaw(i: number) {
  return {
    id: `project-${i}-uuid`,
    name: `Project ${i}`,
    url: `https://linear.app/teros/project/project-${i}`,
    description:
      'Full markdown description of the project with context, milestones, links, ' +
      'and goals written out in several paragraphs to mirror production verbosity.',
    state: ['planned', 'started', 'paused', 'completed', 'canceled'][i % 5],
    icon: null,
    color: '#5E6AD2',
    progress: (i % 10) / 10,
    startDate: '2026-04-01',
    targetDate: '2026-07-01',
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-10T10:00:00Z',
    lead: {
      id: 'lead-uuid',
      name: 'Alice',
      email: 'alice@example.com',
      avatarUrl: 'https://cdn.linear.app/avatars/lead.png',
      active: true,
    },
    teamsList: [
      { id: 't1', name: 'Teros', key: 'TER', icon: '🔷', color: '#5E6AD2' },
      { id: 't2', name: 'Backend', key: 'BE', icon: '🧠', color: '#26B24B' },
    ],
  };
}

describe('context-size regression — list-projects', () => {
  it('curated default is ≥ 50 % smaller than raw', () => {
    const rawProjects = Array.from({ length: 30 }, (_, i) => makeProjectRaw(i));
    const shaped = rawProjects.map((raw) => extractProjectShape(raw));
    const curated = pickFieldsList(shaped as any, [...PROJECT_COMPACT_FIELDS]);

    const rawSize = JSON.stringify(rawProjects).length;
    const curatedSize = JSON.stringify(curated).length;
    const ratio = curatedSize / rawSize;

    // biome-ignore lint/suspicious/noConsoleLog: regression output is lifted into the audit doc
    console.log(
      `[context-size] list-projects raw=${rawSize}B curated=${curatedSize}B ratio=${ratio.toFixed(
        3,
      )} reduction=${((1 - ratio) * 100).toFixed(1)}%`,
    );

    expect(ratio).toBeLessThanOrEqual(0.5);
  });
});

// Note: list-labels was evaluated for a COMPACT whitelist (id + name + color)
// that reached 80 % reduction vs 52 % with the full LABEL_FIELDS default. The
// split was reverted in favour of a lossless default — labels are small
// objects and silently dropping description / parentId by default would be a
// breaking change for zero absolute saving (~2 KB on 16 labels). Callers that
// want the tight shape use the existing `fields: ['id','name','color']`
// override at the call site. The 52 % ratio is documented as P2 structural in
//
