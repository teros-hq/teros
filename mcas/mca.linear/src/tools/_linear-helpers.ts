/**
 * Linear-specific extractors.
 *
 * The Linear SDK returns deeply nested relay objects: `issue.assignee`,
 * `issue.state`, `issue.team`, `issue.project`, `issue.cycle`, `issue.labels()`
 * and `issue.parent` are each async-resolvable relations. These helpers
 * collapse them into flat camelCase shapes the renderer can consume without
 * intermediate parsing.
 *
 * Labels and comments default to the minimum displayable shape (name only
 * for labels; plain body + author for comments). Callers that need the
 * raw SDK node must pass `includeRaw=true` at the tool level.
 */

// ============================================================================
// PRIORITY MAPPING
// ============================================================================

// Linear priority numbering is documented in the GraphQL schema:
//   0 = none, 1 = urgent, 2 = high, 3 = medium, 4 = low
// Source: https://developers.linear.app/docs/graphql/working-with-the-graphql-api
export const PRIORITY_TO_NUMBER: Record<string, number> = {
  none: 0,
  urgent: 1,
  high: 2,
  medium: 3,
  low: 4,
};

export const NUMBER_TO_PRIORITY: Record<number, string> = {
  0: 'none',
  1: 'urgent',
  2: 'high',
  3: 'medium',
  4: 'low',
};

// ============================================================================
// ID VALIDATION
// ============================================================================

const UUID_RE =
  /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

// Linear "human" identifier like "TER-123" or "ENG-4567".
const IDENTIFIER_RE = /^[A-Z][A-Z0-9]{0,9}-\d+$/;

/**
 * Validate a Linear issue id. Accepts both UUIDs and human identifiers
 * (`TEAM-123`) because Linear SDK resolves either against the `issue()`
 * endpoint. Most other endpoints (team, project, label, user, state) expect
 * UUIDs only — use `validateUuid` there.
 */
export function validateIssueId(id: string, label = 'issueId'): string {
  if (typeof id === 'string' && (UUID_RE.test(id) || IDENTIFIER_RE.test(id))) {
    return id;
  }
  throw new Error(
    `Invalid ${label}: expected UUID or identifier (e.g. "TEAM-123"), got "${id}"`,
  );
}

export function validateUuid(id: string, label: string): string {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new Error(`Invalid ${label}: expected UUID, got "${id}"`);
  }
  return id;
}

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Boundary normalisation for optional string params. JSON Schema cannot
 * distinguish between absent and empty/whitespace string, so the LLM often
 * fills `""` for unused optionals. Treat those as undefined.
 */
export function cleanOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

// ============================================================================
// SHARED SHAPES
// ============================================================================

export interface CuratedRef {
  id: string;
  name: string;
}

export interface CuratedUser {
  id: string;
  name: string;
  displayName?: string;
  email?: string;
  avatarUrl?: string | null;
  active?: boolean;
  admin?: boolean;
}

export interface CuratedTeam {
  id: string;
  name: string;
  key: string;
  icon?: string | null;
  color?: string | null;
  description?: string | null;
  private?: boolean;
}

export interface CuratedProjectRef {
  id: string;
  name: string;
  state?: string | null;
  icon?: string | null;
  color?: string | null;
}

export interface CuratedCycleRef {
  id: string;
  name: string | null;
  number: number | null;
}

export interface CuratedLabel {
  id: string;
  name: string;
  color?: string | null;
  description?: string | null;
  isGroup?: boolean;
  parentId?: string | null;
}

export interface CuratedWorkflowState {
  id: string;
  name: string;
  type: string;
  color?: string | null;
  position?: number;
  description?: string | null;
}

export interface CuratedPriority {
  number: number;
  name: string;
}

// ============================================================================
// EXTRACTORS — RELATIONS
// ============================================================================

export function extractUser(u: any): CuratedUser | null {
  if (!u || typeof u !== 'object' || !u.id) return null;
  return {
    id: u.id,
    name: u.name ?? u.displayName ?? '',
    displayName: u.displayName ?? undefined,
    email: u.email ?? undefined,
    avatarUrl: u.avatarUrl ?? null,
    active: u.active ?? undefined,
    admin: u.admin ?? undefined,
  };
}

export function extractTeam(t: any): CuratedTeam | null {
  if (!t || typeof t !== 'object' || !t.id) return null;
  return {
    id: t.id,
    name: t.name ?? '',
    key: t.key ?? '',
    icon: t.icon ?? null,
    color: t.color ?? null,
    description: t.description ?? null,
    private: t.private ?? undefined,
  };
}

export function extractProjectRef(p: any): CuratedProjectRef | null {
  if (!p || typeof p !== 'object' || !p.id) return null;
  return {
    id: p.id,
    name: p.name ?? '',
    state: p.state ?? null,
    icon: p.icon ?? null,
    color: p.color ?? null,
  };
}

export function extractCycleRef(c: any): CuratedCycleRef | null {
  if (!c || typeof c !== 'object' || !c.id) return null;
  return {
    id: c.id,
    name: c.name ?? null,
    number: typeof c.number === 'number' ? c.number : null,
  };
}

export function extractLabel(l: any): CuratedLabel | null {
  if (!l || typeof l !== 'object' || !l.id) return null;
  return {
    id: l.id,
    name: l.name ?? '',
    color: l.color ?? null,
    description: l.description ?? null,
    isGroup: l.isGroup ?? undefined,
    parentId: l.parent?.id ?? l.parentId ?? null,
  };
}

export function extractState(s: any): { name: string; type?: string } | null {
  if (!s || typeof s !== 'object') return null;
  if (typeof s.name !== 'string') return null;
  return { name: s.name, type: s.type ?? undefined };
}

export function extractWorkflowState(s: any): CuratedWorkflowState | null {
  if (!s || typeof s !== 'object' || !s.id) return null;
  return {
    id: s.id,
    name: s.name ?? '',
    type: s.type ?? '',
    color: s.color ?? null,
    position: typeof s.position === 'number' ? s.position : undefined,
    description: s.description ?? null,
  };
}

export function extractPriority(priority: unknown): CuratedPriority {
  if (typeof priority !== 'number') return { number: 0, name: 'none' };
  return { number: priority, name: NUMBER_TO_PRIORITY[priority] ?? 'none' };
}

// ============================================================================
// EXTRACTOR — ISSUE SHAPE
// ============================================================================

export interface CuratedIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  status: string | null;
  priority: CuratedPriority;
  assignee: CuratedUser | null;
  creator?: CuratedUser | null;
  team: CuratedTeam | null;
  project?: CuratedProjectRef | null;
  cycle?: CuratedCycleRef | null;
  labels: string[];
  description: string;
  parentId: string | null;
  dueDate: string | null;
  estimate: number | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IssueShapeDeps {
  state?: any;
  assignee?: any;
  creator?: any;
  team?: any;
  project?: any;
  cycle?: any;
  parent?: any;
  labelNodes?: any[];
}

/**
 * Builds the curated shape from the raw Linear Issue and the pre-resolved
 * relations (which the SDK exposes as async getters — the caller must
 * await them before passing).
 */
export function extractIssueShape(raw: any, deps: IssueShapeDeps = {}): CuratedIssue {
  const stateShape = extractState(deps.state);
  const labels = Array.isArray(deps.labelNodes)
    ? deps.labelNodes.map((l) => l?.name).filter((n): n is string => typeof n === 'string')
    : [];

  return {
    id: raw?.id ?? '',
    identifier: raw?.identifier ?? '',
    title: raw?.title ?? '',
    url: raw?.url ?? '',
    status: stateShape?.name ?? null,
    priority: extractPriority(raw?.priority),
    assignee: extractUser(deps.assignee),
    creator: extractUser(deps.creator),
    team: extractTeam(deps.team),
    project: extractProjectRef(deps.project),
    cycle: extractCycleRef(deps.cycle),
    labels,
    description: typeof raw?.description === 'string' ? raw.description : '',
    parentId: deps.parent?.id ?? raw?.parent?.id ?? null,
    dueDate: raw?.dueDate ?? null,
    estimate: typeof raw?.estimate === 'number' ? raw.estimate : null,
    archivedAt: raw?.archivedAt ?? null,
    createdAt: toIso(raw?.createdAt),
    updatedAt: toIso(raw?.updatedAt),
  };
}

/**
 * Resolves all issue relations and returns the curated shape. Use this when
 * you have a raw SDK `Issue` instance and need full detail (get-issue).
 */
export async function buildIssueShape(issue: any): Promise<CuratedIssue> {
  const [state, assignee, creator, team, project, cycle, parent, labelConn] =
    await Promise.all([
      issue.state,
      issue.assignee,
      issue.creator,
      issue.team,
      issue.project,
      issue.cycle,
      issue.parent,
      issue.labels ? issue.labels() : Promise.resolve({ nodes: [] }),
    ]);
  return extractIssueShape(issue, {
    state,
    assignee,
    creator,
    team,
    project,
    cycle,
    parent,
    labelNodes: labelConn?.nodes ?? [],
  });
}

/**
 * Lightweight shape for list endpoints: resolves only state + assignee + team
 * (the three relations an agent needs to triage a list). Skips labels /
 * project / cycle / parent to avoid N+1 × 7 round-trips on 50-item lists.
 * Callers that need the full shape must fetch each issue via get-issue.
 */
export async function buildIssueListShape(issue: any): Promise<CuratedIssue> {
  const [state, assignee, team] = await Promise.all([
    issue.state,
    issue.assignee,
    issue.team,
  ]);
  return extractIssueShape(issue, { state, assignee, team });
}

// ============================================================================
// EXTRACTOR — PROJECT SHAPE
// ============================================================================

export interface CuratedProject {
  id: string;
  name: string;
  url: string;
  description: string;
  state: string;
  icon: string | null;
  color: string | null;
  progress: number | null;
  startDate: string | null;
  targetDate: string | null;
  lead: CuratedUser | null;
  teams: CuratedRef[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectShapeDeps {
  lead?: any;
  teamNodes?: any[];
}

export function extractProjectShape(raw: any, deps: ProjectShapeDeps = {}): CuratedProject {
  return {
    id: raw?.id ?? '',
    name: raw?.name ?? '',
    url: raw?.url ?? '',
    description: typeof raw?.description === 'string' ? raw.description : '',
    state: raw?.state ?? '',
    icon: raw?.icon ?? null,
    color: raw?.color ?? null,
    progress: typeof raw?.progress === 'number' ? raw.progress : null,
    startDate: raw?.startDate ?? null,
    targetDate: raw?.targetDate ?? null,
    lead: extractUser(deps.lead),
    teams: Array.isArray(deps.teamNodes)
      ? deps.teamNodes
          .map((t) => (t?.id && t?.name ? { id: t.id as string, name: t.name as string } : null))
          .filter((t): t is CuratedRef => t !== null)
      : [],
    createdAt: toIso(raw?.createdAt),
    updatedAt: toIso(raw?.updatedAt),
  };
}

export async function buildProjectShape(project: any): Promise<CuratedProject> {
  const [lead, teamConn] = await Promise.all([
    project.lead ? project.lead : Promise.resolve(null),
    project.teams ? project.teams() : Promise.resolve({ nodes: [] }),
  ]);
  return extractProjectShape(project, { lead, teamNodes: teamConn?.nodes ?? [] });
}

// ============================================================================
// EXTRACTOR — COMMENT SHAPE
// ============================================================================

export interface CuratedComment {
  id: string;
  body: string;
  authorId: string | null;
  authorName: string | null;
  issueId: string | null;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export function extractCommentShape(
  raw: any,
  deps: { user?: any; issue?: any } = {},
): CuratedComment {
  const user = deps.user;
  return {
    id: raw?.id ?? '',
    body: typeof raw?.body === 'string' ? raw.body : '',
    authorId: user?.id ?? raw?.user?.id ?? null,
    authorName: user?.name ?? user?.displayName ?? null,
    issueId: deps.issue?.id ?? raw?.issue?.id ?? null,
    url: raw?.url ?? '',
    createdAt: toIso(raw?.createdAt),
    updatedAt: toIso(raw?.updatedAt),
  };
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return '';
}
