import { holdedRequest } from '../lib/index.js';
import type { ToolConfig } from '@teros/mca-sdk';

// =============================================================================
// TYPES
// =============================================================================

/** Raw project shape returned by the Holded API */
interface HoldedProject {
  id?: string;
  _id?: string;
  name?: string;
  description?: string;
  status?: string;
  start_date?: string;
  end_date?: string;
  budget?: number;
  contact_id?: string;
  created_at?: string;
  updated_at?: string;
}

/** Curated project output returned by our tools */
interface CuratedProject {
  id: string | null;
  name: string | null;
  description: string | null;
  status: string | null;
  startDate: string | null;
  endDate: string | null;
  budget: number | null;
  contactId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Raw task shape returned by the Holded API */
interface HoldedTask {
  id?: string;
  _id?: string;
  name?: string;
  title?: string;
  description?: string;
  project_id?: string;
  assignee_id?: string;
  assigned_to?: string;
  due_date?: string;
  status?: string;
  completed?: boolean;
  created_at?: string;
  updated_at?: string;
}

/** Curated task output returned by our tools */
interface CuratedTask {
  id: string | null;
  name: string | null;
  description: string | null;
  projectId: string | null;
  assigneeId: string | null;
  dueDate: string | null;
  status: string | null;
  completed: boolean | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Raw time entry shape returned by the Holded API */
interface HoldedTimeEntry {
  id?: string;
  _id?: string;
  date?: string;
  duration?: number;
  minutes?: number;
  hours?: number;
  user_id?: string;
  employee_id?: string;
  task_id?: string;
  task_name?: string;
  project_id?: string;
  description?: string;
  billable?: boolean;
  created_at?: string;
}

/** Curated time entry output returned by our tools */
interface CuratedTimeEntry {
  id: string | null;
  date: string | null;
  duration: number | null;
  userId: string | null;
  taskId: string | null;
  taskName: string | null;
  projectId: string | null;
  description: string | null;
  billable: boolean | null;
  createdAt: string | null;
}

// =============================================================================
// MAPPING HELPERS
// =============================================================================

function mapProject(p: HoldedProject): CuratedProject {
  return {
    id: p.id ?? p._id ?? null,
    name: p.name ?? null,
    description: p.description ?? null,
    status: p.status ?? null,
    startDate: p.start_date ?? null,
    endDate: p.end_date ?? null,
    budget: p.budget ?? null,
    contactId: p.contact_id ?? null,
    createdAt: p.created_at ?? null,
    updatedAt: p.updated_at ?? null,
  };
}

function mapTask(t: HoldedTask): CuratedTask {
  return {
    id: t.id ?? t._id ?? null,
    name: t.name ?? t.title ?? null,
    description: t.description ?? null,
    projectId: t.project_id ?? null,
    assigneeId: t.assignee_id ?? t.assigned_to ?? null,
    dueDate: t.due_date ?? null,
    status: t.status ?? null,
    completed: t.completed ?? null,
    createdAt: t.created_at ?? null,
    updatedAt: t.updated_at ?? null,
  };
}

function mapTimeEntry(e: HoldedTimeEntry): CuratedTimeEntry {
  return {
    id: e.id ?? e._id ?? null,
    date: e.date ?? null,
    duration: e.duration ?? e.minutes ?? e.hours ?? null,
    userId: e.user_id ?? e.employee_id ?? null,
    taskId: e.task_id ?? null,
    taskName: e.task_name ?? null,
    projectId: e.project_id ?? null,
    description: e.description ?? null,
    billable: e.billable ?? null,
    createdAt: e.created_at ?? null,
  };
}

// =============================================================================
// LIST PROJECTS
// =============================================================================

export const listProjects: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List projects from Holded. Returns a curated list of projects with id, name, description, status, budget, dates, and contact. Supports pagination via page and limit.',
  parameters: {
    type: 'object',
    properties: {
      page: {
        type: 'number',
        description: 'Page number for pagination (default: 1)',
        default: 1,
      },
      limit: {
        type: 'number',
        description: 'Number of results per page (default: 25, max: 100)',
        default: 25,
      },
    },
  },
  handler: async (args, context) => {
    const { page = 1, limit = 25 } = args as {
      page?: number;
      limit?: number;
    };

    const params: Record<string, string | number> = { page, limit };

    const data = (await holdedRequest(context, '/v2/projects', {
      params,
    })) as HoldedProject[] | { items?: HoldedProject[]; has_more?: boolean; cursor?: string };

    const rawProjects = Array.isArray(data) ? data : (data?.items ?? []);
    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const cursor = Array.isArray(data) ? null : (data?.cursor ?? null);

    const projects = rawProjects.map(mapProject);

    return {
      projects,
      count: projects.length,
      page,
      limit,
      hasMore,
      cursor,
    };
  },
};

// =============================================================================
// GET PROJECT
// =============================================================================

export const getProject: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get a single project from Holded by its ID. Returns full project details including name, description, status, budget, dates, and contact.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Holded project ID',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    const data = (await holdedRequest(
      context,
      `/v2/projects/${encodeURIComponent(id)}`,
    )) as HoldedProject;

    return mapProject(data);
  },
};

// =============================================================================
// GET PROJECT SUMMARY
// =============================================================================

export const getProjectSummary: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get a summary of a Holded project including financial and time metrics such as budget usage, total time, and task counts.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Holded project ID',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    const data = (await holdedRequest(
      context,
      `/v2/projects/${encodeURIComponent(id)}/summary`,
    )) as Record<string, unknown>;

    return {
      id,
      totalTasks: (data.total_tasks as number) ?? (data.tasks as number) ?? null,
      completedTasks: (data.completed_tasks as number) ?? null,
      pendingTasks: (data.pending_tasks as number) ?? null,
      totalTime: (data.total_time as number) ?? (data.total_hours as number) ?? null,
      budgetUsed: (data.budget_used as number) ?? (data.spent as number) ?? null,
      budgetTotal: (data.budget_total as number) ?? (data.budget as number) ?? null,
      progress: (data.progress as number) ?? null,
      team: (data.team as unknown) ?? (data.members as unknown) ?? null,
    };
  },
};

// =============================================================================
// CREATE PROJECT
// =============================================================================

export const createProject: ToolConfig = {
  description: 'Create a new project in Holded.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Project name',
      },
      description: {
        type: 'string',
        description: 'Project description',
      },
      startDate: {
        type: 'string',
        description: 'Project start date (ISO 8601)',
      },
      endDate: {
        type: 'string',
        description: 'Project end date (ISO 8601)',
      },
      budget: {
        type: 'number',
        description: 'Project budget',
      },
      contactId: {
        type: 'string',
        description: 'ID of the associated contact (client)',
      },
    },
    required: ['name'],
  },
  handler: async (args, context) => {
    const { name, description, startDate, endDate, budget, contactId } = args as {
      name: string;
      description?: string;
      startDate?: string;
      endDate?: string;
      budget?: number;
      contactId?: string;
    };

    const body: Record<string, unknown> = { name };
    if (description) body.description = description;
    if (startDate) body.start_date = startDate;
    if (endDate) body.end_date = endDate;
    if (budget !== undefined) body.budget = budget;
    if (contactId) body.contact_id = contactId;

    const data = (await holdedRequest(context, '/v2/projects', {
      method: 'POST',
      body,
    })) as HoldedProject;

    return mapProject(data);
  },
};

// =============================================================================
// UPDATE PROJECT
// =============================================================================

export const updateProject: ToolConfig = {
  description: 'Update an existing project in Holded by its ID.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Holded project ID',
      },
      name: {
        type: 'string',
        description: 'Project name',
      },
      description: {
        type: 'string',
        description: 'Project description',
      },
      startDate: {
        type: 'string',
        description: 'Project start date (ISO 8601)',
      },
      endDate: {
        type: 'string',
        description: 'Project end date (ISO 8601)',
      },
      budget: {
        type: 'number',
        description: 'Project budget',
      },
      contactId: {
        type: 'string',
        description: 'ID of the associated contact (client)',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id, name, description, startDate, endDate, budget, contactId } = args as {
      id: string;
      name?: string;
      description?: string;
      startDate?: string;
      endDate?: string;
      budget?: number;
      contactId?: string;
    };

    const body: Record<string, unknown> = {};
    if (name) body.name = name;
    if (description) body.description = description;
    if (startDate) body.start_date = startDate;
    if (endDate) body.end_date = endDate;
    if (budget !== undefined) body.budget = budget;
    if (contactId) body.contact_id = contactId;

    const data = (await holdedRequest(
      context,
      `/v2/projects/${encodeURIComponent(id)}`,
      { method: 'PUT', body },
    )) as HoldedProject;

    return mapProject(data);
  },
};

// =============================================================================
// DELETE PROJECT
// =============================================================================

export const deleteProject: ToolConfig = {
  description: 'Delete a project from Holded by its ID.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Holded project ID',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    await holdedRequest(context, `/v2/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });

    return { success: true };
  },
};

// =============================================================================
// LIST TASKS
// =============================================================================

export const listTasks: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List tasks from Holded. Returns tasks with id, name, status, assignee, project, and dates. Supports filtering by project and status, plus pagination.',
  parameters: {
    type: 'object',
    properties: {
      page: {
        type: 'number',
        description: 'Page number for pagination (default: 1)',
        default: 1,
      },
      limit: {
        type: 'number',
        description: 'Number of results per page (default: 25, max: 100)',
        default: 25,
      },
      projectId: {
        type: 'string',
        description: 'Filter tasks by project ID',
      },
      status: {
        type: 'string',
        description: 'Filter by task status (e.g. todo, in_progress, done)',
      },
    },
  },
  handler: async (args, context) => {
    const { page = 1, limit = 25, projectId, status } = args as {
      page?: number;
      limit?: number;
      projectId?: string;
      status?: string;
    };

    const params: Record<string, string | number> = { page, limit };
    if (projectId) params.project_id = projectId;
    if (status) params.status = status;

    const data = (await holdedRequest(context, '/v2/tasks', {
      params,
    })) as HoldedTask[] | { items?: HoldedTask[]; has_more?: boolean; cursor?: string };

    const rawTasks = Array.isArray(data) ? data : (data?.items ?? []);
    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const cursor = Array.isArray(data) ? null : (data?.cursor ?? null);

    const tasks = rawTasks.map(mapTask);

    return { tasks, count: tasks.length, page, limit, hasMore, cursor };
  },
};

// =============================================================================
// GET TASK
// =============================================================================

export const getTask: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get a single task from Holded by its ID.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Holded task ID',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    const data = (await holdedRequest(
      context,
      `/v2/tasks/${encodeURIComponent(id)}`,
    )) as HoldedTask;

    return mapTask(data);
  },
};

// =============================================================================
// CREATE TASK
// =============================================================================

export const createTask: ToolConfig = {
  annotations: { readOnlyHint: false },
  description: 'Create a new task in Holded.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Task name',
      },
      projectId: {
        type: 'string',
        description: 'ID of the project this task belongs to',
      },
      description: {
        type: 'string',
        description: 'Task description',
      },
      assigneeId: {
        type: 'string',
        description: 'ID of the assigned team member',
      },
      dueDate: {
        type: 'string',
        description: 'Task due date (ISO 8601)',
      },
      status: {
        type: 'string',
        description: 'Task status (e.g. todo, in_progress, done)',
      },
    },
    required: ['name'],
  },
  handler: async (args, context) => {
    const { name, projectId, description, assigneeId, dueDate, status } = args as {
      name: string;
      projectId?: string;
      description?: string;
      assigneeId?: string;
      dueDate?: string;
      status?: string;
    };

    const body: Record<string, unknown> = { name };
    if (projectId) body.project_id = projectId;
    if (description) body.description = description;
    if (assigneeId) body.assignee_id = assigneeId;
    if (dueDate) body.due_date = dueDate;
    if (status) body.status = status;

    const data = (await holdedRequest(context, '/v2/tasks', {
      method: 'POST',
      body,
    })) as HoldedTask;

    return mapTask(data);
  },
};

// =============================================================================
// LIST PROJECT TIME ENTRIES
// =============================================================================

export const listProjectTimeEntries: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List time entries for a specific Holded project. Returns time entries with id, date, duration, user, and task info. Supports date range filtering and pagination.',
  parameters: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'The Holded project ID',
      },
      cursor: {
        type: 'string',
        description: 'Pagination cursor returned by the previous response. Omit to start from the first page.',
      },
      limit: {
        type: 'number',
        description: 'Number of results per page (default: 25, max: 200)',
        default: 25,
      },
      startDate: {
        type: 'string',
        description: 'Filter entries on or after this date (ISO 8601, YYYY-MM-DD)',
      },
      endDate: {
        type: 'string',
        description: 'Filter entries on or before this date (ISO 8601, YYYY-MM-DD)',
      },
    },
    required: ['projectId'],
  },
  handler: async (args, context) => {
    const { projectId, cursor: cursorParam, limit = 25, startDate, endDate } = args as {
      projectId: string;
      cursor?: string;
      limit?: number;
      startDate?: string;
      endDate?: string;
    };

    const params: Record<string, string | number> = { limit };
    if (cursorParam) params.cursor = cursorParam;
    if (startDate) params.startDate = startDate;
    if (endDate) params.endDate = endDate;

    const data = (await holdedRequest(
      context,
      `/v2/projects/${encodeURIComponent(projectId)}/times`,
      { params },
    )) as HoldedTimeEntry[] | { items?: HoldedTimeEntry[]; has_more?: boolean; cursor?: string };

    const rawEntries = Array.isArray(data) ? data : (data?.items ?? []);
    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const nextCursor = Array.isArray(data) ? null : (data?.cursor ?? null);

    const timeEntries = rawEntries.map(mapTimeEntry);

    const page = cursorParam ? null : 1;
    return { timeEntries, count: timeEntries.length, page, limit, hasMore, cursor: nextCursor };
  },
};

// =============================================================================
// LIST ALL TIME ENTRIES
// =============================================================================

export const listAllTimeEntries: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List all time entries across all Holded projects. Returns time entries with id, date, duration, user, task, and project info. Cursor-paginated: pass the cursor from the previous response to fetch the next page.',
  parameters: {
    type: 'object',
    properties: {
      cursor: {
        type: 'string',
        description: 'Pagination cursor returned by the previous response. Omit to start from the first page.',
      },
      limit: {
        type: 'number',
        description: 'Number of results per page (default: 25, max: 200)',
        default: 25,
      },
    },
  },
  handler: async (args, context) => {
    const { cursor: cursorParam, limit = 25 } = args as {
      cursor?: string;
      limit?: number;
    };

    const params: Record<string, string | number> = { limit };
    if (cursorParam) params.cursor = cursorParam;

    const data = (await holdedRequest(context, '/v2/project-times', {
      params,
    })) as HoldedTimeEntry[] | { items?: HoldedTimeEntry[]; has_more?: boolean; cursor?: string };

    const rawEntries = Array.isArray(data) ? data : (data?.items ?? []);
    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const nextCursor = Array.isArray(data) ? null : (data?.cursor ?? null);

    const timeEntries = rawEntries.map(mapTimeEntry);

    const page = cursorParam ? null : 1;
    return { timeEntries, count: timeEntries.length, page, limit, hasMore, cursor: nextCursor };
  },
};
