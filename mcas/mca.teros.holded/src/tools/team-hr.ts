import { holdedRequest } from '../lib/index.js';
import type { ToolConfig } from '@teros/mca-sdk';

// =============================================================================
// TYPES
// =============================================================================

/** Raw employee shape returned by the Holded API */
interface HoldedEmployee {
  id?: string;
  _id?: string;
  name?: string;
  email?: string;
  phone?: string;
  department?: string;
  position?: string;
  status?: string;
  start_date?: string;
  created_at?: string;
  updated_at?: string;
}

/** Curated employee output returned by our tools */
interface CuratedEmployee {
  id: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  department: string | null;
  position: string | null;
  status: string | null;
  startDate: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Raw employee time entry shape returned by the Holded API */
interface HoldedEmployeeTimeEntry {
  id?: string;
  _id?: string;
  date?: string;
  clock_in?: string;
  start_time?: string;
  clock_out?: string;
  end_time?: string;
  duration?: number;
  minutes?: number;
  type?: string;
  project_id?: string;
  task_id?: string;
  notes?: string;
  created_at?: string;
}

/** Curated employee time entry output returned by our tools */
interface CuratedEmployeeTimeEntry {
  id: string | null;
  date: string | null;
  clockIn: string | null;
  clockOut: string | null;
  duration: number | null;
  type: string | null;
  projectId: string | null;
  taskId: string | null;
  notes: string | null;
  createdAt: string | null;
}

/** Raw payslip shape returned by the Holded API */
interface HoldedPayslip {
  id?: string;
  _id?: string;
  employee_id?: string;
  employee_name?: string;
  period?: string;
  gross_amount?: number;
  gross?: number;
  net_amount?: number;
  net?: number;
  deductions?: number;
  taxes?: number;
  currency?: string;
  status?: string;
  created_at?: string;
}

/** Curated payslip output returned by our tools */
interface CuratedPayslip {
  id: string | null;
  employeeId: string | null;
  employeeName: string | null;
  period: string | null;
  grossAmount: number | null;
  netAmount: number | null;
  deductions: number | null;
  taxes: number | null;
  currency: string | null;
  status: string | null;
  createdAt: string | null;
}

/** Raw time-off request shape returned by the Holded API */
interface HoldedTimeOffRequest {
  id?: string;
  _id?: string;
  employee_id?: string | null;
  time_off_type_id?: string | null;
  time_off_type_name?: string | null;
  start_date?: string;
  end_date?: string | null;
  day_period?: string | null;
  status?: string | null;
  days?: string;
  description?: string | null;
  reason?: string | null;
  start_hour?: string | null;
  end_hour?: string | null;
  num_hours?: string | null;
  attachments?: object[];
}

/** Curated time-off request output returned by our tools */
interface CuratedTimeOffRequest {
  id: string | null;
  employeeId: string | null;
  timeOffTypeId: string | null;
  timeOffTypeName: string | null;
  startDate: string | null;
  endDate: string | null;
  dayPeriod: string | null;
  status: string | null;
  days: string | null;
  description: string | null;
  reason: string | null;
  startHour: string | null;
  endHour: string | null;
  numHours: string | null;
  attachments: object[];
}

// =============================================================================
// MAPPING HELPERS
// =============================================================================

function mapEmployee(e: HoldedEmployee): CuratedEmployee {
  return {
    id: e.id ?? e._id ?? null,
    name: e.name ?? null,
    email: e.email ?? null,
    phone: e.phone ?? null,
    department: e.department ?? null,
    position: e.position ?? null,
    status: e.status ?? null,
    startDate: e.start_date ?? null,
    createdAt: e.created_at ?? null,
    updatedAt: e.updated_at ?? null,
  };
}

function mapEmployeeTimeEntry(e: HoldedEmployeeTimeEntry): CuratedEmployeeTimeEntry {
  return {
    id: e.id ?? e._id ?? null,
    date: e.date ?? null,
    clockIn: e.clock_in ?? e.start_time ?? null,
    clockOut: e.clock_out ?? e.end_time ?? null,
    duration: e.duration ?? e.minutes ?? null,
    type: e.type ?? null,
    projectId: e.project_id ?? null,
    taskId: e.task_id ?? null,
    notes: e.notes ?? null,
    createdAt: e.created_at ?? null,
  };
}

function mapPayslip(p: HoldedPayslip): CuratedPayslip {
  return {
    id: p.id ?? p._id ?? null,
    employeeId: p.employee_id ?? null,
    employeeName: p.employee_name ?? null,
    period: p.period ?? null,
    grossAmount: p.gross_amount ?? p.gross ?? null,
    netAmount: p.net_amount ?? p.net ?? null,
    deductions: p.deductions ?? null,
    taxes: p.taxes ?? null,
    currency: p.currency ?? null,
    status: p.status ?? null,
    createdAt: p.created_at ?? null,
  };
}

function mapTimeOffRequest(r: HoldedTimeOffRequest): CuratedTimeOffRequest {
  return {
    id: r.id ?? r._id ?? null,
    employeeId: r.employee_id ?? null,
    timeOffTypeId: r.time_off_type_id ?? null,
    timeOffTypeName: r.time_off_type_name ?? null,
    startDate: r.start_date ?? null,
    endDate: r.end_date ?? null,
    dayPeriod: r.day_period ?? null,
    status: r.status ?? null,
    days: r.days ?? null,
    description: r.description ?? null,
    reason: r.reason ?? null,
    startHour: r.start_hour ?? null,
    endHour: r.end_hour ?? null,
    numHours: r.num_hours ?? null,
    attachments: r.attachments ?? [],
  };
}

// =============================================================================
// LIST EMPLOYEES
// =============================================================================

export const listEmployees: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List employees from Holded. Returns a curated list with id, name, email, phone, department, position, status, startDate, and timestamps. Supports pagination.',
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

    const data = (await holdedRequest(context, '/v2/employees', {
      params,
    })) as HoldedEmployee[] | { items?: HoldedEmployee[]; has_more?: boolean; cursor?: string };

    const rawEmployees = Array.isArray(data) ? data : (data?.items ?? []);
    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const cursor = Array.isArray(data) ? null : (data?.cursor ?? null);

    const employees = rawEmployees.map(mapEmployee);

    return { employees, count: employees.length, page, limit, hasMore, cursor };
  },
};

// =============================================================================
// GET EMPLOYEE
// =============================================================================

export const getEmployee: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get a single employee from Holded by their ID. Returns full employee details including name, email, phone, department, position, status, and dates.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Holded employee ID',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    const data = (await holdedRequest(
      context,
      `/v2/employees/${encodeURIComponent(id)}`,
    )) as HoldedEmployee;

    return mapEmployee(data);
  },
};

// =============================================================================
// LIST EMPLOYEE TIME ENTRIES
// =============================================================================

export const listEmployeeTimeEntries: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List time tracking entries for a specific Holded employee. Returns clock-in/out records with dates and durations. Supports date range filtering and pagination.',
  parameters: {
    type: 'object',
    properties: {
      employeeId: {
        type: 'string',
        description: 'The Holded employee ID',
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
    required: ['employeeId'],
  },
  handler: async (args, context) => {
    const { employeeId, cursor: cursorParam, limit = 25, startDate, endDate } = args as {
      employeeId: string;
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
      `/v2/employees/${encodeURIComponent(employeeId)}/times`,
      { params },
    )) as HoldedEmployeeTimeEntry[] | { items?: HoldedEmployeeTimeEntry[]; has_more?: boolean; cursor?: string };

    const rawEntries = Array.isArray(data) ? data : (data?.items ?? []);
    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const nextCursor = Array.isArray(data) ? null : (data?.cursor ?? null);

    const timeEntries = rawEntries.map(mapEmployeeTimeEntry);

    const page = cursorParam ? null : 1;
    return { timeEntries, count: timeEntries.length, page, limit, hasMore, cursor: nextCursor };
  },
};

// =============================================================================
// LIST ALL EMPLOYEE TIME ENTRIES
// =============================================================================

export const listAllEmployeeTimeEntries: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List time tracking entries across all Holded employees. Returns clock-in/out records with dates and durations. Cursor-paginated: pass the cursor from the previous response to fetch the next page.',
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

    const data = (await holdedRequest(context, '/v2/employee-times', {
      params,
    })) as HoldedEmployeeTimeEntry[] | { items?: HoldedEmployeeTimeEntry[]; has_more?: boolean; cursor?: string };

    const rawEntries = Array.isArray(data) ? data : (data?.items ?? []);
    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const nextCursor = Array.isArray(data) ? null : (data?.cursor ?? null);

    const timeEntries = rawEntries.map(mapEmployeeTimeEntry);

    const page = cursorParam ? null : 1;
    return { timeEntries, count: timeEntries.length, page, limit, hasMore, cursor: nextCursor };
  },
};

// =============================================================================
// LIST PAYSLIPS
// =============================================================================

export const listPayslips: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List payslips from Holded. Returns a curated list with id, employee, period, gross/net amounts, and status. Supports filtering by employee, status, and period, plus pagination.',
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
      employeeId: {
        type: 'string',
        description: 'Filter payslips by employee ID',
      },
      status: {
        type: 'string',
        description: 'Filter by payslip status (e.g. draft, approved, paid)',
      },
      period: {
        type: 'string',
        description: 'Filter by pay period (e.g. 2026-01 for January 2026)',
      },
    },
  },
  handler: async (args, context) => {
    const { page = 1, limit = 25, employeeId, status, period } = args as {
      page?: number;
      limit?: number;
      employeeId?: string;
      status?: string;
      period?: string;
    };

    const params: Record<string, string | number> = { page, limit };
    if (employeeId) params.employee_id = employeeId;
    if (status) params.status = status;
    if (period) params.period = period;

    const data = (await holdedRequest(context, '/v2/payslips', {
      params,
    })) as HoldedPayslip[] | { items?: HoldedPayslip[]; has_more?: boolean; cursor?: string };

    const rawPayslips = Array.isArray(data) ? data : (data?.items ?? []);
    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const cursor = Array.isArray(data) ? null : (data?.cursor ?? null);

    const payslips = rawPayslips.map(mapPayslip);

    return { payslips, count: payslips.length, page, limit, hasMore, cursor };
  },
};

// =============================================================================
// GET PAYSLIP
// =============================================================================

export const getPayslip: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get a single payslip from Holded by its ID. Returns full payslip details including employee, period, gross/net amounts, deductions, taxes, and status.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Holded payslip ID',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    const data = (await holdedRequest(
      context,
      `/v2/payslips/${encodeURIComponent(id)}`,
    )) as HoldedPayslip;

    return mapPayslip(data);
  },
};

// =============================================================================
// LIST TIME-OFF REQUESTS
// =============================================================================

export const listTimeOffRequests: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List time-off requests from Holded. Returns a curated list with id, employee, type, dates, and approval status. Supports filtering by employee, status, and type, plus pagination.',
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Number of results per page (default: 50)',
        default: 50,
      },
      cursor: {
        type: 'string',
        description: 'Pagination cursor from a previous response. Pass the cursor value to get the next page.',
      },
      employeeId: {
        type: 'string',
        description: 'Filter by employee ID. When provided, queries the per-employee endpoint.',
      },
      status: {
        type: 'string',
        description: 'Filter by approval status (e.g. pending, accepted, rejected, cancelled)',
      },
      timeOffTypeId: {
        type: 'string',
        description: 'Filter by time-off type ID (e.g. holiday, sick leave, vacation)',
      },
      teamId: {
        type: 'string',
        description: 'Filter by team ID (account-wide endpoint only)',
      },
      startDateFrom: {
        type: 'string',
        description: 'Start date lower bound (YYYY-MM-DD, e.g. 2026-01-01). Required by the API. Defaults to the start of the current year.',
      },
      startDateTo: {
        type: 'string',
        description: 'Start date upper bound (YYYY-MM-DD, e.g. 2026-12-31). Required by the API. Defaults to the end of the current year.',
      },
    },
  },
  handler: async (args, context) => {
    const { limit = 50, cursor, employeeId, status, timeOffTypeId, teamId, startDateFrom, startDateTo } = args as {
      limit?: number;
      cursor?: string;
      employeeId?: string;
      status?: string;
      timeOffTypeId?: string;
      teamId?: string;
      startDateFrom?: string;
      startDateTo?: string;
    };

    const params: Record<string, string | number> = { limit };
    if (cursor) params.cursor = cursor;
    if (status) params.status = status;
    if (timeOffTypeId) params.time_off_type_id = timeOffTypeId;
    if (teamId) params.team_id = teamId;

    // The API requires start_date_from and start_date_to in ATOM datetime format (Y-m-d\TH:i:sP).
    // Default to the current calendar year. Accept plain dates (YYYY-MM-DD) and convert.
    const now = new Date();
    const year = now.getUTCFullYear();
    const toAtom = (d: string) => d.length === 10 ? `${d}T00:00:00+00:00` : d;
    params.start_date_from = toAtom(startDateFrom ?? `${year}-01-01`);
    params.start_date_to = toAtom(startDateTo ?? `${year}-12-31`);

    // Account-wide endpoint: GET /v2/employees/time-offs
    // Per-employee endpoint: GET /v2/employees/{employeeId}/time-offs
    const path = employeeId
      ? `/v2/employees/${encodeURIComponent(employeeId)}/time-offs`
      : '/v2/employees/time-offs';
    const data = (await holdedRequest(context, path, {
      params,
    })) as HoldedTimeOffRequest[] | { items?: HoldedTimeOffRequest[]; has_more?: boolean; cursor?: string };

    const rawRequests = Array.isArray(data) ? data : (data?.items ?? []);
    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const nextCursor = Array.isArray(data) ? null : (data?.cursor ?? null);

    const requests = rawRequests.map(mapTimeOffRequest);

    return { requests, count: requests.length, limit, hasMore, cursor: nextCursor };
  },
};

// =============================================================================
// GET TIME-OFF REQUEST
// =============================================================================

export const getTimeOffRequest: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'Get a single time-off request from Holded by its ID. Returns full details including employee, type, dates, days, approval status, and approver info.',
  parameters: {
    type: 'object',
    properties: {
      employeeId: {
        type: 'string',
        description: 'The Holded employee ID (24-character hex ObjectId)',
      },
      id: {
        type: 'string',
        description: 'The Holded time-off request ID (24-character hex ObjectId)',
      },
    },
    required: ['employeeId', 'id'],
  },
  handler: async (args, context) => {
    const { employeeId, id } = args as { employeeId: string; id: string };

    const data = (await holdedRequest(
      context,
      `/v2/employees/${encodeURIComponent(employeeId)}/time-offs/${encodeURIComponent(id)}`,
    )) as HoldedTimeOffRequest;

    return mapTimeOffRequest(data);
  },
};
