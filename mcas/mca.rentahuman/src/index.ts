#!/usr/bin/env npx tsx

/**
 * RentAHuman.ai MCA v1.0.0
 *
 * Allows AI agents to hire humans for physical-world tasks.
 * Integrates with the RentAHuman.ai REST API.
 *
 * Tools:
 *   - search-humans   — find humans by skill, rate, name (no auth required)
 *   - get-human       — full profile with availability & wallets (no auth required)
 *   - create-booking  — book a human for a task (requires API key)
 *   - list-bookings   — list agent's bookings (requires API key)
 *   - get-booking     — get booking status (requires API key)
 *
 * Auth: userSecrets.RENTAHUMAN_API_KEY (write operations only)
 * Docs: https://rentahuman.ai/api-docs
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';

// =============================================================================
// CONFIGURATION
// =============================================================================

const RAH_BASE_URL = 'https://rentahuman.ai/api';
const AGENT_TYPE = 'other';

// =============================================================================
// TYPES
// =============================================================================

interface RahSecrets {
  RENTAHUMAN_API_KEY?: string;
}

interface HumanProfile {
  id: string;
  name: string;
  headline?: string;
  bio?: string;
  skills?: string[];
  expertise?: string[];
  location?: {
    city?: string;
    state?: string;
    country?: string;
  };
  hourlyRate?: number;
  currency?: string;
  availability?: Record<string, unknown>;
  timezone?: string;
  rating?: number;
  reviewCount?: number;
  isAvailable?: boolean;
  isVerified?: boolean;
  isFeatured?: boolean;
}

interface Booking {
  id: string;
  humanId: string;
  agentId?: string;
  agentName?: string;
  agentType?: string;
  taskTitle: string;
  taskDescription: string;
  taskCategory?: string;
  startTime: string;
  endTime?: string;
  estimatedHours: number;
  totalAmount?: number;
  currency?: string;
  paymentStatus?: string;
  status: string;
}

// =============================================================================
// API HELPERS
// =============================================================================

/**
 * Make an authenticated request to the RentAHuman API
 */
async function rahRequest(
  path: string,
  options: {
    method?: string;
    apiKey?: string;
    body?: unknown;
    params?: Record<string, string | number | undefined>;
  } = {},
): Promise<unknown> {
  const { method = 'GET', apiKey, body, params } = options;

  // Build URL with query parameters
  const url = new URL(`${RAH_BASE_URL}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }

  const fetchOptions: RequestInit = {
    method,
    headers,
  };

  if (body && method !== 'GET') {
    fetchOptions.body = JSON.stringify(body);
  }

  const response = await fetch(url.toString(), fetchOptions);

  if (!response.ok) {
    let errorMessage = `RentAHuman API error: ${response.status} ${response.statusText}`;
    try {
      const errorBody = await response.json() as { error?: string; message?: string };
      if (errorBody.error || errorBody.message) {
        errorMessage += ` — ${errorBody.error || errorBody.message}`;
      }
    } catch {
      // ignore JSON parse errors
    }
    throw new Error(errorMessage);
  }

  return response.json();
}

/**
 * Format a human profile for display
 */
function formatHuman(h: HumanProfile): string {
  const lines: string[] = [];

  lines.push(`**${h.name}** (ID: ${h.id})`);

  if (h.headline) lines.push(`_${h.headline}_`);

  const locationParts = [h.location?.city, h.location?.state, h.location?.country].filter(Boolean);
  if (locationParts.length > 0) lines.push(`📍 ${locationParts.join(', ')}`);

  if (h.hourlyRate !== undefined) {
    lines.push(`💰 ${h.hourlyRate} ${h.currency || 'USD'}/hr`);
  }

  if (h.rating !== undefined) {
    lines.push(`⭐ ${h.rating.toFixed(1)} (${h.reviewCount || 0} reviews)`);
  }

  const badges: string[] = [];
  if (h.isAvailable) badges.push('✅ Available');
  if (h.isVerified) badges.push('✓ Verified');
  if (h.isFeatured) badges.push('⭐ Featured');
  if (badges.length > 0) lines.push(badges.join(' · '));

  if (h.skills && h.skills.length > 0) {
    lines.push(`🛠 Skills: ${h.skills.slice(0, 8).join(', ')}${h.skills.length > 8 ? '...' : ''}`);
  }

  if (h.timezone) lines.push(`🕐 Timezone: ${h.timezone}`);

  return lines.join('\n');
}

/**
 * Format a booking for display
 */
function formatBooking(b: Booking): string {
  const lines: string[] = [];

  lines.push(`**Booking ${b.id}**`);
  lines.push(`Task: ${b.taskTitle}`);
  lines.push(`Human ID: ${b.humanId}`);
  lines.push(`Status: ${b.status.toUpperCase()}`);

  if (b.paymentStatus) lines.push(`Payment: ${b.paymentStatus}`);
  if (b.startTime) lines.push(`Start: ${new Date(b.startTime).toLocaleString()}`);
  if (b.endTime) lines.push(`End: ${new Date(b.endTime).toLocaleString()}`);
  if (b.estimatedHours) lines.push(`Duration: ${b.estimatedHours}h`);
  if (b.totalAmount !== undefined) {
    lines.push(`Total: ${b.totalAmount} ${b.currency || 'USD'}`);
  }
  if (b.taskCategory) lines.push(`Category: ${b.taskCategory}`);

  return lines.join('\n');
}

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.rentahuman',
  name: 'RentAHuman.ai',
  version: '1.0.0',
});

// -----------------------------------------------------------------------------
// Health Check
// -----------------------------------------------------------------------------

server.tool('-health-check', {
  description: 'Internal health check tool. Verifies RentAHuman.ai API connectivity.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder().setVersion('1.0.0');

    // Check user secrets
    try {
      const userSecrets = await context.getUserSecrets() as RahSecrets;

      if (!userSecrets.RENTAHUMAN_API_KEY) {
        builder.addIssue(
          'USER_CONFIG_MISSING',
          'RentAHuman API key not configured (optional for read-only use)',
          {
            type: 'user_action',
            description:
              'Configure your RENTAHUMAN_API_KEY in app settings to enable bookings. Search and browse are free without a key.',
          },
        );
      }
    } catch {
      // Secrets not available — that's fine, search still works
    }

    // Verify API connectivity with a lightweight public call
    try {
      await rahRequest('/humans', { params: { limit: 1 } });
    } catch (err) {
      builder.addIssue(
        'CONNECTIVITY',
        `Cannot reach RentAHuman API: ${err instanceof Error ? err.message : String(err)}`,
        {
          type: 'admin_action',
          description: 'Check network connectivity to rentahuman.ai',
        },
      );
    }

    return builder.build();
  },
});

// -----------------------------------------------------------------------------
// search-humans
// -----------------------------------------------------------------------------

server.tool('search-humans', {
  annotations: { readOnlyHint: true },
  description:
    'Search for available humans on RentAHuman.ai. Filter by skill, hourly rate range, or name. No API key required — searching is free.',
  parameters: {
    type: 'object',
    properties: {
      skill: {
        type: 'string',
        description:
          "Filter by skill (e.g., 'Photography', 'In-Person Meetings', 'Errands', 'Translation')",
      },
      name: {
        type: 'string',
        description: 'Filter by human name',
      },
      minRate: {
        type: 'number',
        description: 'Minimum hourly rate in USD',
      },
      maxRate: {
        type: 'number',
        description: 'Maximum hourly rate in USD',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (default: 20, max: 100)',
        default: 20,
      },
    },
  },
  handler: async (args) => {
    const { skill, name, minRate, maxRate, limit = 20 } = args as {
      skill?: string;
      name?: string;
      minRate?: number;
      maxRate?: number;
      limit?: number;
    };

    const data = await rahRequest('/humans', {
      params: {
        skill,
        name,
        minRate,
        maxRate,
        limit: Math.min(Number(limit) || 20, 100),
      },
    }) as { success: boolean; humans: HumanProfile[]; count: number };

    if (!data.humans || data.humans.length === 0) {
      return 'No humans found matching your criteria. Try broadening your search.';
    }

    const lines: string[] = [
      `Found **${data.count ?? data.humans.length}** humans:\n`,
    ];

    for (const human of data.humans) {
      lines.push(formatHuman(human));
      lines.push('---');
    }

    return lines.join('\n');
  },
});

// -----------------------------------------------------------------------------
// get-human
// -----------------------------------------------------------------------------

server.tool('get-human', {
  annotations: { readOnlyHint: true },
  description:
    'Get the full profile of a specific human including skills, availability, hourly rate, location, rating, and payment wallet addresses.',
  parameters: {
    type: 'object',
    properties: {
      humanId: {
        type: 'string',
        description: "The human's profile ID",
      },
    },
    required: ['humanId'],
  },
  handler: async (args) => {
    const { humanId } = args as { humanId: string };

    if (!humanId) throw new Error('humanId is required');

    const data = await rahRequest(`/humans/${encodeURIComponent(humanId)}`) as {
      success: boolean;
      human: HumanProfile & {
        wallets?: Record<string, string>;
        bio?: string;
        availability?: Record<string, unknown>;
      };
    };

    const h = data.human;
    const lines: string[] = [formatHuman(h)];

    if (h.bio) {
      lines.push(`\n**Bio:**\n${h.bio}`);
    }

    if (h.expertise && h.expertise.length > 0) {
      lines.push(`\n**Expertise:** ${h.expertise.join(', ')}`);
    }

    if (h.availability && Object.keys(h.availability).length > 0) {
      lines.push('\n**Availability:**');
      for (const [day, slots] of Object.entries(h.availability)) {
        lines.push(`  ${day}: ${JSON.stringify(slots)}`);
      }
    }

    if (h.wallets && Object.keys(h.wallets).length > 0) {
      lines.push('\n**Payment Wallets:**');
      for (const [chain, address] of Object.entries(h.wallets)) {
        lines.push(`  ${chain}: \`${address}\``);
      }
    }

    return lines.join('\n');
  },
});

// -----------------------------------------------------------------------------
// create-booking
// -----------------------------------------------------------------------------

server.tool('create-booking', {
  annotations: { readOnlyHint: false },
  description:
    'Book a human for a physical-world task. Requires a RENTAHUMAN_API_KEY. Returns booking details and payment instructions.',
  parameters: {
    type: 'object',
    properties: {
      humanId: {
        type: 'string',
        description: 'The ID of the human to book',
      },
      taskTitle: {
        type: 'string',
        description: 'Brief title of the task (3-200 characters)',
      },
      taskDescription: {
        type: 'string',
        description: 'Detailed description of what the human needs to do',
      },
      taskCategory: {
        type: 'string',
        description:
          "Task category (e.g., 'errands', 'meetings', 'research', 'photography', 'delivery')",
      },
      startTime: {
        type: 'string',
        description: "When the task should start (ISO 8601 format, e.g., '2025-06-15T10:00:00Z')",
      },
      estimatedHours: {
        type: 'number',
        description: 'Estimated hours needed (min: 0.5, max: 168)',
      },
      agentName: {
        type: 'string',
        description: "Your agent's display name (optional)",
      },
    },
    required: ['humanId', 'taskTitle', 'taskDescription', 'startTime', 'estimatedHours'],
  },
  handler: async (args, context) => {
    const {
      humanId,
      taskTitle,
      taskDescription,
      taskCategory,
      startTime,
      estimatedHours,
      agentName,
    } = args as {
      humanId: string;
      taskTitle: string;
      taskDescription: string;
      taskCategory?: string;
      startTime: string;
      estimatedHours: number;
      agentName?: string;
    };

    // Validate required fields
    if (!humanId) throw new Error('humanId is required');
    if (!taskTitle || taskTitle.length < 3) throw new Error('taskTitle must be at least 3 characters');
    if (!taskDescription) throw new Error('taskDescription is required');
    if (!startTime) throw new Error('startTime is required (ISO 8601 format)');
    if (!estimatedHours || estimatedHours < 0.5) throw new Error('estimatedHours must be at least 0.5');

    // Get API key
    const userSecrets = await context.getUserSecrets() as RahSecrets;
    const apiKey = userSecrets.RENTAHUMAN_API_KEY;

    if (!apiKey) {
      throw new Error(
        'RENTAHUMAN_API_KEY not configured. Please add your API key in app settings to create bookings.',
      );
    }

    // Build a stable agent ID from the context (use a hash-like string)
    const agentId = `teros-agent-${Date.now()}`;

    const data = await rahRequest('/bookings', {
      method: 'POST',
      apiKey,
      body: {
        humanId,
        agentId,
        agentName: agentName || 'Teros Agent',
        agentType: AGENT_TYPE,
        taskTitle,
        taskDescription,
        taskCategory,
        startTime,
        estimatedHours: Number(estimatedHours),
      },
    }) as { success: boolean; booking: Booking; message?: string };

    const lines: string[] = ['✅ **Booking created successfully!**\n'];
    lines.push(formatBooking(data.booking));

    if (data.message) {
      lines.push(`\n**Payment Instructions:**\n${data.message}`);
    }

    return lines.join('\n');
  },
});

// -----------------------------------------------------------------------------
// list-bookings
// -----------------------------------------------------------------------------

server.tool('list-bookings', {
  annotations: { readOnlyHint: true },
  description:
    "List bookings for the current agent. Optionally filter by status. Requires a RENTAHUMAN_API_KEY.",
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['pending', 'confirmed', 'in_progress', 'completed', 'cancelled'],
        description: 'Filter by booking status',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results (default: 20)',
        default: 20,
      },
    },
  },
  handler: async (args, context) => {
    const { status, limit = 20 } = args as {
      status?: string;
      limit?: number;
    };

    const userSecrets = await context.getUserSecrets() as RahSecrets;
    const apiKey = userSecrets.RENTAHUMAN_API_KEY;

    if (!apiKey) {
      throw new Error(
        'RENTAHUMAN_API_KEY not configured. Please add your API key in app settings.',
      );
    }

    const data = await rahRequest('/bookings', {
      apiKey,
      params: {
        status,
        limit: Math.min(Number(limit) || 20, 100),
      },
    }) as { success: boolean; bookings: Booking[] };

    if (!data.bookings || data.bookings.length === 0) {
      return status
        ? `No bookings found with status "${status}".`
        : 'No bookings found.';
    }

    const lines: string[] = [`**${data.bookings.length} booking(s):**\n`];

    for (const booking of data.bookings) {
      lines.push(formatBooking(booking));
      lines.push('---');
    }

    return lines.join('\n');
  },
});

// -----------------------------------------------------------------------------
// get-booking
// -----------------------------------------------------------------------------

server.tool('get-booking', {
  annotations: { readOnlyHint: true },
  description:
    'Get the details and current status of a specific booking. Requires a RENTAHUMAN_API_KEY.',
  parameters: {
    type: 'object',
    properties: {
      bookingId: {
        type: 'string',
        description: 'The booking ID to retrieve',
      },
    },
    required: ['bookingId'],
  },
  handler: async (args, context) => {
    const { bookingId } = args as { bookingId: string };

    if (!bookingId) throw new Error('bookingId is required');

    const userSecrets = await context.getUserSecrets() as RahSecrets;
    const apiKey = userSecrets.RENTAHUMAN_API_KEY;

    if (!apiKey) {
      throw new Error(
        'RENTAHUMAN_API_KEY not configured. Please add your API key in app settings.',
      );
    }

    const data = await rahRequest(`/bookings/${encodeURIComponent(bookingId)}`, {
      apiKey,
    }) as { success: boolean; booking: Booking };

    return formatBooking(data.booking);
  },
});

// =============================================================================
// START SERVER
// =============================================================================

server
  .start()
  .then(() => {
    console.error('🧑 RentAHuman.ai MCA server running');
  })
  .catch((error) => {
    console.error('Failed to start RentAHuman MCA:', error);
    process.exit(1);
  });
