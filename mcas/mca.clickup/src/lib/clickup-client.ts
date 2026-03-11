import type { ToolContext } from '@teros/mca-sdk';

const BASE_URL = 'https://api.clickup.com/api/v2';

export async function clickupRequest(
  context: ToolContext,
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
    params?: Record<string, string | number | boolean | undefined>;
  } = {},
): Promise<unknown> {
  const userSecrets = await context.getUserSecrets();
  const token = userSecrets.ACCESS_TOKEN as string | undefined;

  if (!token) {
    throw new Error('ClickUp account not connected. Please connect your ClickUp account via OAuth.');
  }

  const { method = 'GET', body, params } = options;

  let url = `${BASE_URL}${path}`;

  if (params) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        searchParams.append(key, String(value));
      }
    }
    const qs = searchParams.toString();
    if (qs) url += `?${qs}`;
  }

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    let errorMessage: string;
    try {
      const errorJson = JSON.parse(errorText);
      errorMessage = errorJson.err || errorJson.error || errorText;
    } catch {
      errorMessage = errorText;
    }
    throw new Error(`ClickUp API error ${response.status}: ${errorMessage}`);
  }

  if (response.status === 204) return { success: true };

  return response.json();
}

/**
 * Maps priority string to ClickUp priority number
 */
export function mapPriority(priority?: string): number | undefined {
  if (!priority) return undefined;
  const map: Record<string, number> = { urgent: 1, high: 2, normal: 3, low: 4 };
  return map[priority.toLowerCase()];
}

/**
 * Formats a ClickUp task for clean output
 */
export function formatTask(task: any) {
  return {
    id: task.id,
    name: task.name,
    description: task.description,
    status: task.status?.status ?? null,
    priority: task.priority?.priority ?? null,
    assignees: task.assignees?.map((a: any) => ({ id: a.id, username: a.username, email: a.email })) ?? [],
    tags: task.tags?.map((t: any) => t.name) ?? [],
    dueDate: task.due_date ? new Date(parseInt(task.due_date)).toISOString() : null,
    startDate: task.start_date ? new Date(parseInt(task.start_date)).toISOString() : null,
    createdAt: task.date_created ? new Date(parseInt(task.date_created)).toISOString() : null,
    updatedAt: task.date_updated ? new Date(parseInt(task.date_updated)).toISOString() : null,
    creator: task.creator
      ? { id: task.creator.id, username: task.creator.username, email: task.creator.email }
      : null,
    list: task.list ? { id: task.list.id, name: task.list.name } : null,
    folder: task.folder ? { id: task.folder.id, name: task.folder.name } : null,
    url: task.url ?? null,
    parent: task.parent ?? null,
  };
}
