export const SPACES = ['personal', 'shared'] as const;
export type Space = (typeof SPACES)[number];

export function isSpace(value: unknown): value is Space {
  return value === 'personal' || value === 'shared';
}

export const ACCESS_ACTIONS = ['see', 'use', 'control', 'manage'] as const;
export type AccessAction = (typeof ACCESS_ACTIONS)[number];

export type MemberRole = 'owner' | 'admin' | 'write' | 'read';

const ROLE_RANK: Record<MemberRole, number> = { read: 1, write: 2, admin: 3, owner: 4 };

export function roleReaches(role: MemberRole | null | undefined, floor: MemberRole): boolean {
  return !!role && ROLE_RANK[role] >= ROLE_RANK[floor];
}

export interface MemberPrincipal {
  kind: 'member';
  userId: string;
  workspaceId: string;
  role: MemberRole | null;
}

export interface AgentPrincipal {
  kind: 'agent';
  workspaces: readonly string[];
  agentId?: string;
}

export type Principal = MemberPrincipal | AgentPrincipal;

export interface Thing {
  kind: string;
  workspaceId: string;
  space: Space;
  ownerId?: string | null;
  watchable?: boolean;
  agents?: boolean;
}

export interface KindPolicy {
  entry: MemberRole;
  shared: Record<AccessAction, MemberRole>;
  agents: readonly AccessAction[];
}

export type AccessRefusal =
  | 'other_workspace'
  | 'not_a_member'
  | 'role'
  | 'no_owner'
  | 'personal'
  | 'view_only'
  | 'agents_off'
  | 'people_only';

export type AccessDecision = { allowed: true } | { allowed: false; reason: AccessRefusal };

const ALLOW: AccessDecision = { allowed: true };
const refuse = (reason: AccessRefusal): AccessDecision => ({ allowed: false, reason });

function evaluateAgent(
  principal: AgentPrincipal,
  thing: Thing,
  action: AccessAction,
  policy: KindPolicy,
): AccessDecision {
  if (!principal.workspaces.includes(thing.workspaceId)) return refuse('other_workspace');
  if (thing.agents !== true) return refuse('agents_off');
  if (!policy.agents.includes(action)) return refuse('people_only');
  return ALLOW;
}

function evaluateMember(
  principal: MemberPrincipal,
  thing: Thing,
  action: AccessAction,
  policy: KindPolicy,
): AccessDecision {
  if (principal.workspaceId !== thing.workspaceId) return refuse('other_workspace');
  if (!principal.role) return refuse('not_a_member');
  if (!roleReaches(principal.role, policy.entry)) return refuse('role');
  if (thing.space === 'shared')
    return roleReaches(principal.role, policy.shared[action]) ? ALLOW : refuse('role');
  if (!thing.ownerId) return refuse('no_owner');
  if (thing.ownerId === principal.userId) return ALLOW;
  if (thing.watchable !== true) return refuse('personal');
  return action === 'see' ? ALLOW : refuse('view_only');
}

export function evaluateAccess(
  principal: Principal,
  thing: Thing,
  action: AccessAction,
  policy: KindPolicy,
): AccessDecision {
  return principal.kind === 'agent'
    ? evaluateAgent(principal, thing, action, policy)
    : evaluateMember(principal, thing, action, policy);
}

export function mayAccess(
  principal: Principal,
  thing: Thing,
  action: AccessAction,
  policy: KindPolicy,
): boolean {
  return evaluateAccess(principal, thing, action, policy).allowed;
}

export function actionsFor(principal: Principal, thing: Thing, policy: KindPolicy): AccessAction[] {
  return ACCESS_ACTIONS.filter((action) => mayAccess(principal, thing, action, policy));
}

const REFUSAL_TEXT: Record<AccessRefusal, string> = {
  other_workspace: 'This belongs to another workspace.',
  not_a_member: 'You are not a member of this workspace.',
  role: 'Your role in this workspace does not allow this.',
  no_owner: 'This personal item has no owner on record, so nobody can open it.',
  personal: 'This is personal to another member of the workspace.',
  view_only: 'Its owner lets the workspace watch it: you can look, not act.',
  agents_off: 'Agents are switched off here: a person has to switch "Agent" on first.',
  people_only: 'Only a person can do this.',
};

export function refusalText(reason: AccessRefusal): string {
  return REFUSAL_TEXT[reason];
}

export const TERMINAL_SESSION_KIND = 'terminal.session';

export const TERMINAL_SESSION_POLICY: KindPolicy = {
  entry: 'write',
  shared: { see: 'write', use: 'write', control: 'write', manage: 'write' },
  agents: ['see', 'use', 'manage'],
};

export interface TerminalSessionShape {
  createdBy?: string | null;
  space?: Space | null;
  watchable?: boolean;
  agentControl?: boolean;
}

export function terminalSessionPerson(createdBy: string | null | undefined): string | null {
  return createdBy && !createdBy.startsWith('agent:') ? createdBy : null;
}

export function terminalSessionSpace(session: TerminalSessionShape): Space {
  if (isSpace(session.space)) return session.space;
  return terminalSessionPerson(session.createdBy) ? 'personal' : 'shared';
}

export function terminalSessionThing(session: TerminalSessionShape, workspaceId: string): Thing {
  const space = terminalSessionSpace(session);
  const opener = session.createdBy ?? '';
  return {
    kind: TERMINAL_SESSION_KIND,
    workspaceId,
    space,
    ownerId: space === 'personal' ? terminalSessionPerson(opener) : null,
    watchable: space === 'personal' && session.watchable === true,
    agents: opener.startsWith('agent:') || session.agentControl === true,
  };
}
