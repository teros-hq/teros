import { describe, expect, it } from 'bun:test';
import {
  ACCESS_ACTIONS,
  type AccessAction,
  type AccessDecision,
  type KindPolicy,
  type Principal,
  type Thing,
  TERMINAL_SESSION_POLICY,
  actionsFor,
  evaluateAccess,
  isSpace,
  refusalText,
} from './sharing';

const WS = 'work_a';
const OTHER = 'work_b';

const member = (userId: string, role: 'owner' | 'admin' | 'write' | 'read' | null, workspaceId = WS): Principal => ({
  kind: 'member',
  userId,
  workspaceId,
  role,
});
const agent = (...workspaces: string[]): Principal => ({ kind: 'agent', workspaces });

const thing = (over: Partial<Thing> = {}): Thing => ({
  kind: 'terminal.session',
  workspaceId: WS,
  space: 'personal',
  ownerId: 'ada',
  watchable: false,
  agents: false,
  ...over,
});

const DOCS: KindPolicy = {
  entry: 'read',
  shared: { see: 'read', use: 'write', control: 'write', manage: 'admin' },
  agents: ['see', 'use'],
};

const verdict = (d: AccessDecision): string => (d.allowed ? 'allow' : d.reason);

type Row = [string, Principal, Thing, AccessAction, string];

const TABLE: Row[] = [
  ['the owner sees their personal thing', member('ada', 'write'), thing(), 'see', 'allow'],
  ['the owner uses it', member('ada', 'write'), thing(), 'use', 'allow'],
  ['the owner controls it', member('ada', 'write'), thing(), 'control', 'allow'],
  ['the owner manages it', member('ada', 'write'), thing(), 'manage', 'allow'],
  ['another member does not see a personal thing', member('quinn', 'write'), thing(), 'see', 'personal'],
  ['a workspace admin does not see it either', member('root', 'admin'), thing(), 'see', 'personal'],
  ['the workspace owner does not see it either', member('boss', 'owner'), thing(), 'use', 'personal'],
  ['watch lets another member see', member('quinn', 'write'), thing({ watchable: true }), 'see', 'allow'],
  ['watch never lets them use', member('quinn', 'write'), thing({ watchable: true }), 'use', 'view_only'],
  ['watch never lets them control', member('quinn', 'admin'), thing({ watchable: true }), 'control', 'view_only'],
  ['watch never lets them manage', member('quinn', 'owner'), thing({ watchable: true }), 'manage', 'view_only'],
  ['a personal thing with no owner is nobody\'s', member('ada', 'owner'), thing({ ownerId: null }), 'see', 'no_owner'],
  ['a member below the kind\'s entry role gets nothing of their own', member('ada', 'read'), thing(), 'see', 'role'],
  ['nor of a watched thing', member('quinn', 'read'), thing({ watchable: true }), 'see', 'role'],
  ['a shared thing is every write member\'s to see', member('quinn', 'write'), thing({ space: 'shared', ownerId: null }), 'see', 'allow'],
  ['to use', member('quinn', 'write'), thing({ space: 'shared', ownerId: null }), 'use', 'allow'],
  ['to control', member('quinn', 'write'), thing({ space: 'shared', ownerId: null }), 'control', 'allow'],
  ['to manage', member('quinn', 'write'), thing({ space: 'shared', ownerId: null }), 'manage', 'allow'],
  ['a shared thing is not the read member\'s', member('rita', 'read'), thing({ space: 'shared', ownerId: null }), 'see', 'role'],
  ['someone who is not a member gets nothing', member('eve', null), thing({ space: 'shared', ownerId: null }), 'see', 'not_a_member'],
  ['a member of another workspace gets nothing', member('ada', 'owner', OTHER), thing({ space: 'shared' }), 'see', 'other_workspace'],
  ['not even of what they own there', member('ada', 'owner', OTHER), thing(), 'see', 'other_workspace'],
  ['an agent does not see a personal thing with agents off', agent(WS), thing(), 'see', 'agents_off'],
  ['being shared does not let agents in', agent(WS), thing({ space: 'shared', ownerId: null }), 'see', 'agents_off'],
  ['watch does not let agents in', agent(WS), thing({ watchable: true }), 'see', 'agents_off'],
  ['agents on lets an agent see a personal thing', agent(WS), thing({ agents: true }), 'see', 'allow'],
  ['and use it', agent(WS), thing({ agents: true }), 'use', 'allow'],
  ['and manage it', agent(WS), thing({ agents: true }), 'manage', 'allow'],
  ['an agent never controls: that is a person\'s switch', agent(WS), thing({ agents: true }), 'control', 'people_only'],
  ['agents on lets an agent use a shared thing', agent(WS), thing({ space: 'shared', ownerId: null, agents: true }), 'use', 'allow'],
  ['an agent of another workspace gets nothing', agent(OTHER), thing({ space: 'shared', agents: true }), 'see', 'other_workspace'],
  ['an agent let into no workspace gets nothing', agent(), thing({ agents: true }), 'see', 'other_workspace'],
  ['a superagent reaches the workspaces it was let into', agent(OTHER, WS), thing({ agents: true }), 'use', 'allow'],
];

describe('one rule for who may see, use, control and manage a thing', () => {
  for (const [title, principal, target, action, expected] of TABLE) {
    it(`[SPACE-AC-1] ${title} (${action} → ${expected})`, () => {
      expect(verdict(evaluateAccess(principal, target, action, TERMINAL_SESSION_POLICY))).toBe(expected);
    });
  }

  it('[SPACE-AC-2] a kind sets its own role floor per action in the shared space', () => {
    const doc = thing({ kind: 'doc', space: 'shared', ownerId: null, agents: true });
    expect(verdict(evaluateAccess(member('rita', 'read'), doc, 'see', DOCS))).toBe('allow');
    expect(verdict(evaluateAccess(member('rita', 'read'), doc, 'use', DOCS))).toBe('role');
    expect(verdict(evaluateAccess(member('quinn', 'write'), doc, 'manage', DOCS))).toBe('role');
    expect(verdict(evaluateAccess(member('root', 'admin'), doc, 'manage', DOCS))).toBe('allow');
    expect(verdict(evaluateAccess(agent(WS), doc, 'manage', DOCS))).toBe('people_only');
  });

  it('[SPACE-AC-3] a personal thing is its owner\'s whatever their role above the entry floor', () => {
    const mine = thing({ kind: 'doc', ownerId: 'rita' });
    for (const action of ACCESS_ACTIONS)
      expect(verdict(evaluateAccess(member('rita', 'read'), mine, action, DOCS))).toBe('allow');
  });

  it('[SPACE-AC-4] the list of actions a principal has is the same rule, asked four times', () => {
    expect(actionsFor(member('ada', 'write'), thing(), TERMINAL_SESSION_POLICY)).toEqual([...ACCESS_ACTIONS]);
    expect(actionsFor(member('quinn', 'write'), thing({ watchable: true }), TERMINAL_SESSION_POLICY)).toEqual(['see']);
    expect(actionsFor(member('quinn', 'write'), thing(), TERMINAL_SESSION_POLICY)).toEqual([]);
    expect(actionsFor(agent(WS), thing({ agents: true }), TERMINAL_SESSION_POLICY)).toEqual(['see', 'use', 'manage']);
  });

  it('[SPACE-AC-5] every refusal has plain words, and a space is one of two', () => {
    for (const reason of [
      'other_workspace',
      'not_a_member',
      'role',
      'no_owner',
      'personal',
      'view_only',
      'agents_off',
      'people_only',
    ] as const)
      expect(refusalText(reason).length).toBeGreaterThan(10);
    expect(isSpace('personal')).toBe(true);
    expect(isSpace('shared')).toBe(true);
    expect(isSpace('private')).toBe(false);
    expect(isSpace(undefined)).toBe(false);
  });
});
