import { holdedRequest } from '../lib/index.js';
import type { ToolConfig } from '@teros/mca-sdk';

// =============================================================================
// TYPES
// =============================================================================

/** Raw event shape returned by the Holded API */
interface HoldedEvent {
  id?: string;
  _id?: string;
  title?: string;
  name?: string;
  description?: string;
  start?: string;
  end?: string;
  start_date?: string;
  end_date?: string;
  all_day?: boolean;
  location?: string;
  attendees?: string[];
  created_at?: string;
  updated_at?: string;
}

/** Curated event output returned by our tools */
interface CuratedEvent {
  id: string | null;
  title: string | null;
  description: string | null;
  start: string | null;
  end: string | null;
  allDay: boolean | null;
  location: string | null;
  attendees: string[] | null;
  createdAt: string | null;
  updatedAt: string | null;
}

// =============================================================================
// MAPPING HELPER
// =============================================================================

function mapEvent(e: HoldedEvent): CuratedEvent {
  return {
    id: e.id ?? e._id ?? null,
    title: e.title ?? e.name ?? null,
    description: e.description ?? null,
    start: e.start ?? e.start_date ?? null,
    end: e.end ?? e.end_date ?? null,
    allDay: e.all_day ?? null,
    location: e.location ?? null,
    attendees: e.attendees ?? null,
    createdAt: e.created_at ?? null,
    updatedAt: e.updated_at ?? null,
  };
}

// =============================================================================
// LIST EVENTS
// =============================================================================

export const listEvents: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List calendar events from Holded. Returns events with id, title, start/end dates, all-day flag, location, and attendees. Supports pagination and date range filtering.',
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
      startDate: {
        type: 'string',
        description: 'Filter events starting from this date (ISO 8601, e.g. 2026-01-01)',
      },
      endDate: {
        type: 'string',
        description: 'Filter events ending before this date (ISO 8601, e.g. 2026-12-31)',
      },
    },
  },
  handler: async (args, context) => {
    const { page = 1, limit = 25, startDate, endDate } = args as {
      page?: number;
      limit?: number;
      startDate?: string;
      endDate?: string;
    };

    const params: Record<string, string | number> = { page, limit };
    if (startDate) params.start_date = startDate;
    if (endDate) params.end_date = endDate;

    const data = (await holdedRequest(context, '/v2/events', {
      params,
    })) as HoldedEvent[] | { items?: HoldedEvent[]; has_more?: boolean; cursor?: string };

    const rawEvents = Array.isArray(data) ? data : (data?.items ?? []);
    const hasMore = Array.isArray(data) ? false : (data?.has_more ?? false);
    const cursor = Array.isArray(data) ? null : (data?.cursor ?? null);

    const events = rawEvents.map(mapEvent);

    return { events, count: events.length, page, limit, hasMore, cursor };
  },
};

// =============================================================================
// GET EVENT
// =============================================================================

export const getEvent: ToolConfig = {
  annotations: { readOnlyHint: true },
  description: 'Get a single calendar event from Holded by its ID.',
  parameters: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The Holded event ID',
      },
    },
    required: ['id'],
  },
  handler: async (args, context) => {
    const { id } = args as { id: string };

    const data = (await holdedRequest(
      context,
      `/v2/events/${encodeURIComponent(id)}`,
    )) as HoldedEvent;

    return mapEvent(data);
  },
};

// =============================================================================
// CREATE EVENT
// =============================================================================

export const createEvent: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Create a new calendar event in Holded. Requires a title, start date, and end date.',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Event title',
      },
      description: {
        type: 'string',
        description: 'Event description',
      },
      start: {
        type: 'string',
        description: 'Event start date (ISO 8601, e.g. 2026-01-15T10:00:00)',
      },
      end: {
        type: 'string',
        description: 'Event end date (ISO 8601, e.g. 2026-01-15T11:00:00)',
      },
      allDay: {
        type: 'boolean',
        description: 'Whether this is an all-day event',
      },
      location: {
        type: 'string',
        description: 'Event location',
      },
      attendees: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of attendee email addresses',
      },
    },
    required: ['title', 'start', 'end'],
  },
  handler: async (args, context) => {
    const { title, description, start, end, allDay, location, attendees } = args as {
      title: string;
      description?: string;
      start: string;
      end: string;
      allDay?: boolean;
      location?: string;
      attendees?: string[];
    };

    const body: Record<string, unknown> = { title, start, end };
    if (description) body.description = description;
    if (allDay !== undefined) body.all_day = allDay;
    if (location) body.location = location;
    if (attendees) body.attendees = attendees;

    const data = (await holdedRequest(context, '/v2/events', {
      method: 'POST',
      body,
    })) as HoldedEvent;

    return mapEvent(data);
  },
};
