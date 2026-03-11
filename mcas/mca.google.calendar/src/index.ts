#!/usr/bin/env npx tsx

/**
 * Google Calendar MCA
 *
 * Calendar management using McaServer with HTTP transport.
 * Secrets are fetched on-demand from backend via callbackUrl.
 *
 * Deployment: per-app (each installed app gets its own process)
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';

// =============================================================================
// TYPES
// =============================================================================

interface CalendarSecrets {
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
  REDIRECT_URIS?: string;
  ACCESS_TOKEN?: string;
  REFRESH_TOKEN?: string;
  EMAIL?: string;
  EXPIRY_DATE?: string;
}

// =============================================================================
// CALENDAR CLIENT FACTORY
// =============================================================================

/**
 * Creates an authenticated Google Calendar client from secrets
 */
async function createCalendarClient(secrets: CalendarSecrets) {
  const clientId = secrets.CLIENT_ID;
  const clientSecret = secrets.CLIENT_SECRET;
  const redirectUrisRaw = secrets.REDIRECT_URIS;

  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth credentials not configured. Missing CLIENT_ID or CLIENT_SECRET.');
  }

  // Parse redirect URI
  // Falls back to TEROS_BACKEND_URL env var, or localhost for self-hosted installs
  const backendUrl = process.env.TEROS_BACKEND_URL || 'http://localhost:3000';
  let redirectUri = `${backendUrl}/auth/callback`;
  if (redirectUrisRaw) {
    try {
      const uris = JSON.parse(redirectUrisRaw);
      redirectUri = Array.isArray(uris) ? uris[0] : redirectUrisRaw;
    } catch {
      redirectUri = redirectUrisRaw;
    }
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  // Set tokens
  const accessToken = secrets.ACCESS_TOKEN;
  const refreshToken = secrets.REFRESH_TOKEN;
  const expiryDate = secrets.EXPIRY_DATE ? parseInt(secrets.EXPIRY_DATE, 10) : undefined;

  if (!accessToken || !refreshToken) {
    throw new Error('Google account not connected. Please connect your Google account.');
  }

  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
    expiry_date: expiryDate,
  });

  // Check if token needs refresh
  const needsRefresh = !accessToken || (expiryDate && expiryDate < Date.now() + 60000);
  if (needsRefresh && refreshToken) {
    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);
    } catch (error: any) {
      throw new Error(`Failed to refresh token: ${error.message}`);
    }
  }

  return {
    calendar: google.calendar({ version: 'v3', auth: oauth2Client }),
    email: secrets.EMAIL || 'unknown@gmail.com',
    displayName: getDisplayName(secrets.EMAIL),
  };
}

function getDisplayName(email?: string): string | undefined {
  if (!email) return undefined;
  const localPart = email.split('@')[0];
  return localPart
    .split(/[._-]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.google.calendar',
  name: 'Google Calendar',
  version: '2.0.0',
});

// -----------------------------------------------------------------------------
// Health Check Tool
// -----------------------------------------------------------------------------

server.tool('-health-check', {
  description: 'Internal health check tool. Verifies OAuth credentials and connectivity.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (args, context) => {
    const builder = new HealthCheckBuilder().setVersion('2.0.0');

    try {
      const systemSecrets = await context.getSystemSecrets();
      const userSecrets = await context.getUserSecrets();
      const secrets = { ...systemSecrets, ...userSecrets } as CalendarSecrets;

      // Check system secrets
      if (!secrets.CLIENT_ID) {
        builder.addIssue('SYSTEM_CONFIG_MISSING', 'Google OAuth Client ID not configured', {
          type: 'admin_action',
          description: 'Configure CLIENT_ID in system secrets',
        });
      }
      if (!secrets.CLIENT_SECRET) {
        builder.addIssue('SYSTEM_CONFIG_MISSING', 'Google OAuth Client Secret not configured', {
          type: 'admin_action',
          description: 'Configure CLIENT_SECRET in system secrets',
        });
      }

      // Check user credentials
      if (!secrets.ACCESS_TOKEN || !secrets.REFRESH_TOKEN) {
        builder.addIssue('AUTH_REQUIRED', 'Google account not connected', {
          type: 'user_action',
          description: 'Connect your Google account to use Calendar',
        });
      } else {
        // Try to validate credentials
        try {
          const { calendar } = await createCalendarClient(secrets);
          await calendar.calendarList.list({ maxResults: 1 });
        } catch (apiError: any) {
          if (apiError.code === 401 || apiError.code === 403) {
            builder.addIssue('AUTH_EXPIRED', 'Google Calendar access token expired or revoked', {
              type: 'user_action',
              description: 'Reconnect your Google account',
            });
          } else {
            builder.addIssue(
              'DEPENDENCY_UNAVAILABLE',
              `Google Calendar API error: ${apiError.message}`,
              {
                type: 'auto_retry',
                description: 'Google Calendar API temporarily unavailable',
              },
            );
          }
        }
      }
    } catch (error) {
      builder.addIssue(
        'SYSTEM_CONFIG_MISSING',
        error instanceof Error ? error.message : 'Failed to get secrets',
        {
          type: 'admin_action',
          description: 'Ensure callbackUrl is provided and backend is reachable',
        },
      );
    }

    return builder.build();
  },
});

// -----------------------------------------------------------------------------
// List Events
// -----------------------------------------------------------------------------

server.tool('calendar-list-events', {
  description:
    'List calendar events within a date range. Returns events from primary calendar or specified calendar.',
  parameters: {
    type: 'object',
    properties: {
      startDate: {
        type: 'string',
        description: 'Start date in ISO format (e.g., "2025-10-29T00:00:00Z")',
      },
      endDate: {
        type: 'string',
        description: 'End date in ISO format (e.g., "2025-10-30T23:59:59Z")',
      },
      calendarId: {
        type: 'string',
        description: 'Calendar ID (defaults to "primary" for main calendar)',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of events to return (default: 10)',
      },
    },
    required: ['startDate', 'endDate'],
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as CalendarSecrets;
    const { calendar, email } = await createCalendarClient(secrets);

    const calendarId = (args.calendarId as string) || 'primary';
    const maxResults = (args.maxResults as number) || 10;
    const startDate = args.startDate as string;
    const endDate = args.endDate as string;

    const response = await calendar.events.list({
      calendarId,
      timeMin: startDate,
      timeMax: endDate,
      maxResults,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = response.data.items || [];

    return {
      account: email,
      count: events.length,
      events: events.map((e: any) => ({
        id: e.id,
        summary: e.summary,
        start: e.start?.dateTime || e.start?.date,
        end: e.end?.dateTime || e.end?.date,
        description: e.description,
        location: e.location,
        attendees: e.attendees?.map((a: any) => a.email),
      })),
    };
  },
});

// -----------------------------------------------------------------------------
// Create Event
// -----------------------------------------------------------------------------

server.tool('calendar-create-event', {
  description: 'Create a new calendar event with title, start/end times, and optional details.',
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Event title/summary' },
      start: {
        type: 'string',
        description: 'Start time in ISO format (e.g., "2025-10-29T14:00:00+01:00")',
      },
      end: {
        type: 'string',
        description: 'End time in ISO format (e.g., "2025-10-29T15:00:00+01:00")',
      },
      description: { type: 'string', description: 'Event description (optional)' },
      location: { type: 'string', description: 'Event location (optional)' },
      attendees: {
        type: 'array',
        description: 'List of attendee emails (optional)',
        items: { type: 'string' },
      },
      calendarId: {
        type: 'string',
        description: 'Calendar ID (defaults to "primary" for main calendar)',
      },
    },
    required: ['summary', 'start', 'end'],
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as CalendarSecrets;
    const { calendar, email } = await createCalendarClient(secrets);

    const calendarId = (args.calendarId as string) || 'primary';

    const event = {
      summary: args.summary as string,
      description: args.description as string | undefined,
      location: args.location as string | undefined,
      start: {
        dateTime: args.start as string,
      },
      end: {
        dateTime: args.end as string,
      },
      attendees: (args.attendees as string[] | undefined)?.map((email) => ({ email })),
    };

    const response = await calendar.events.insert({
      calendarId,
      requestBody: event,
    });

    return {
      success: true,
      account: email,
      eventId: response.data.id,
      event: {
        id: response.data.id,
        summary: response.data.summary,
        start: response.data.start?.dateTime || response.data.start?.date,
        end: response.data.end?.dateTime || response.data.end?.date,
        htmlLink: response.data.htmlLink,
      },
    };
  },
});

// -----------------------------------------------------------------------------
// Update Event
// -----------------------------------------------------------------------------

server.tool('calendar-update-event', {
  description:
    'Update an existing calendar event. You can modify title, times, description, location, or attendees.',
  parameters: {
    type: 'object',
    properties: {
      eventId: { type: 'string', description: 'The ID of event to update' },
      summary: { type: 'string', description: 'New event title/summary (optional)' },
      start: {
        type: 'string',
        description: 'New start time in ISO format (optional, e.g., "2025-10-29T14:00:00+01:00")',
      },
      end: {
        type: 'string',
        description: 'New end time in ISO format (optional, e.g., "2025-10-29T15:00:00+01:00")',
      },
      description: { type: 'string', description: 'New event description (optional)' },
      location: { type: 'string', description: 'New event location (optional)' },
      attendees: {
        type: 'array',
        description: 'New list of attendee emails (optional)',
        items: { type: 'string' },
      },
      calendarId: {
        type: 'string',
        description: 'Calendar ID (defaults to "primary" for main calendar)',
      },
    },
    required: ['eventId'],
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as CalendarSecrets;
    const { calendar, email } = await createCalendarClient(secrets);

    const calendarId = (args.calendarId as string) || 'primary';
    const eventId = args.eventId as string;

    const existingEvent = await calendar.events.get({
      calendarId,
      eventId,
    });

    const updates: any = {};
    if (args.summary) updates.summary = args.summary;
    if (args.description) updates.description = args.description;
    if (args.location) updates.location = args.location;
    if (args.start) updates.start = { dateTime: args.start };
    if (args.end) updates.end = { dateTime: args.end };
    if (args.attendees) {
      updates.attendees = (args.attendees as string[]).map((email) => ({
        email,
      }));
    }

    const response = await calendar.events.patch({
      calendarId,
      eventId,
      requestBody: updates,
    });

    return {
      success: true,
      account: email,
      eventId: response.data.id,
      event: {
        id: response.data.id,
        summary: response.data.summary,
        start: response.data.start?.dateTime || response.data.start?.date,
        end: response.data.end?.dateTime || response.data.end?.date,
      },
    };
  },
});

// -----------------------------------------------------------------------------
// Delete Event
// -----------------------------------------------------------------------------

server.tool('calendar-delete-event', {
  description: 'Delete a calendar event by its ID.',
  parameters: {
    type: 'object',
    properties: {
      eventId: { type: 'string', description: 'The ID of the event to delete' },
      calendarId: {
        type: 'string',
        description: 'Calendar ID (defaults to "primary" for main calendar)',
      },
    },
    required: ['eventId'],
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as CalendarSecrets;
    const { calendar, email } = await createCalendarClient(secrets);

    const calendarId = (args.calendarId as string) || 'primary';
    const eventId = args.eventId as string;

    await calendar.events.delete({
      calendarId,
      eventId,
    });

    return {
      success: true,
      account: email,
      message: `Event ${eventId} deleted successfully`,
    };
  },
});

// -----------------------------------------------------------------------------
// Search Events
// -----------------------------------------------------------------------------

server.tool('calendar-search-events', {
  description:
    'Search for events by text query. Searches event titles, descriptions, and locations.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query text' },
      maxResults: {
        type: 'number',
        description: 'Maximum number of results to return (default: 10)',
      },
      calendarId: {
        type: 'string',
        description: 'Calendar ID (defaults to "primary" for main calendar)',
      },
    },
    required: ['query'],
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as CalendarSecrets;
    const { calendar, email } = await createCalendarClient(secrets);

    const calendarId = (args.calendarId as string) || 'primary';
    const maxResults = (args.maxResults as number) || 10;
    const query = args.query as string;

    const response = await calendar.events.list({
      calendarId,
      q: query,
      maxResults,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = response.data.items || [];

    return {
      account: email,
      count: events.length,
      query,
      events: events.map((e: any) => ({
        id: e.id,
        summary: e.summary,
        start: e.start?.dateTime || e.start?.date,
        end: e.end?.dateTime || e.end?.date,
        description: e.description,
        location: e.location,
      })),
    };
  },
});

// -----------------------------------------------------------------------------
// Get Free/Busy
// -----------------------------------------------------------------------------

server.tool('calendar-get-free-busy', {
  description: 'Check availability / free-busy information for a time range.',
  parameters: {
    type: 'object',
    properties: {
      startDate: {
        type: 'string',
        description: 'Start date in ISO format (e.g., "2025-10-29T00:00:00Z")',
      },
      endDate: {
        type: 'string',
        description: 'End date in ISO format (e.g., "2025-10-30T23:59:59Z")',
      },
      calendarIds: {
        type: 'array',
        description: 'List of calendar IDs to check (defaults to ["primary"])',
        items: { type: 'string' },
      },
    },
    required: ['startDate', 'endDate'],
  },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as CalendarSecrets;
    const { calendar, email } = await createCalendarClient(secrets);

    const calendarIds = (args.calendarIds as string[]) || ['primary'];
    const startDate = args.startDate as string;
    const endDate = args.endDate as string;

    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin: startDate,
        timeMax: endDate,
        items: calendarIds.map((id) => ({ id })),
      },
    });

    return {
      account: email,
      calendars: response.data.calendars,
    };
  },
});

// -----------------------------------------------------------------------------
// Start Server
// -----------------------------------------------------------------------------

server.start();
