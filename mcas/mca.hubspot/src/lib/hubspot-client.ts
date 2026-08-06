/**
 * HubSpot API Client Manager
 *
 * Manages authentication and API requests for HubSpot REST API v3.
 * Features:
 * - OAuth2 with automatic refresh token handling
 * - Rate limiting with retry and exponential backoff
 * - Robust error handling (token expired, rate limit, etc.)
 */

import type { ToolContext } from '@teros/mca-sdk';

// =============================================================================
// TYPES
// =============================================================================

export interface HubSpotSecrets {
  ACCESS_TOKEN?: string;
  REFRESH_TOKEN?: string;
}

export interface HubSpotSystemSecrets {
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: number;
  retryAfter?: number;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const BASE_URL = 'https://api.hubapi.com';
const TOKEN_URL = 'https://api.hubapi.com/oauth/v1/token';

// CRM Lists API v3 (date-versioned path). Replaces the SUNSET /contacts/v1/lists
// (dead since 2026-04-30). Kept as a single constant so the version date is in one place.
export const LISTS_API = '/crm/lists/2026-03';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const RATE_LIMIT_STATUS = 429;
const UNAUTHORIZED_STATUS = 401;

// HubSpot daily limit: 100 requests/10 seconds for OAuth apps
// We track this conservatively
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL_MS = 110; // ~9 requests/second max

// =============================================================================
// RATE LIMITING
// =============================================================================

async function respectRateLimit(): Promise<void> {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < MIN_REQUEST_INTERVAL_MS) {
    await sleep(MIN_REQUEST_INTERVAL_MS - timeSinceLastRequest);
  }
  lastRequestTime = Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelay(attempt: number, retryAfter?: number): number {
  if (retryAfter && retryAfter > 0) {
    return retryAfter * 1000;
  }
  // Exponential backoff: 1s, 2s, 4s
  return BASE_DELAY_MS * Math.pow(2, attempt);
}

// =============================================================================
// TOKEN REFRESH
// =============================================================================

async function refreshAccessToken(
  context: ToolContext,
  refreshToken: string,
): Promise<string> {
  const systemSecrets = (await context.getSystemSecrets()) as HubSpotSystemSecrets;
  const clientId = systemSecrets.CLIENT_ID;
  const clientSecret = systemSecrets.CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'HubSpot OAuth client credentials not configured. Please set CLIENT_ID and CLIENT_SECRET.',
    );
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(
      `HubSpot token refresh failed (${response.status}): ${errorText}. Please reconnect your HubSpot account.`,
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  // Update the stored access token via the context callback
  // Note: The backend should handle persisting the new token
  // We return the new token for immediate use
  return data.access_token;
}

// =============================================================================
// CLIENT
// =============================================================================

/**
 * Make an authenticated request to the HubSpot API with retry and backoff.
 */
export async function hubspotRequest(
  context: ToolContext,
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
    params?: Record<string, string | number | boolean | undefined>;
    skipRateLimit?: boolean;
  } = {},
): Promise<unknown> {
  const userSecrets = (await context.getUserSecrets()) as HubSpotSecrets;
  let token = userSecrets.ACCESS_TOKEN;
  const refreshToken = userSecrets.REFRESH_TOKEN;

  if (!token) {
    throw new Error(
      'HubSpot account not connected. Please connect your HubSpot account via OAuth.',
    );
  }

  const { method = 'GET', body, params, skipRateLimit = false } = options;

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

  // Attempt the request with retries
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (!skipRateLimit) {
        await respectRateLimit();
      }

      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      // Handle rate limiting
      if (response.status === RATE_LIMIT_STATUS) {
        const retryAfterHeader = response.headers.get('Retry-After');
        const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;

        if (attempt < MAX_RETRIES) {
          const delay = getRetryDelay(attempt, retryAfter);
          await sleep(delay);
          continue;
        }
        const errorText = await response.text().catch(() => response.statusText);
        throw new Error(
          `HubSpot API rate limit exceeded after ${MAX_RETRIES} retries: ${errorText}`,
        );
      }

      // Handle token expiration - try refresh once
      if (response.status === UNAUTHORIZED_STATUS && refreshToken && attempt === 0) {
        try {
          token = await refreshAccessToken(context, refreshToken);
          // Retry immediately with new token
          continue;
        } catch (refreshError) {
          throw new Error(
            `HubSpot authentication failed: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`,
          );
        }
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        let errorMessage: string;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.message || errorJson.error || errorText;
        } catch {
          errorMessage = errorText;
        }

        // Retry on 5xx errors
        if (response.status >= 500 && attempt < MAX_RETRIES) {
          const delay = getRetryDelay(attempt);
          await sleep(delay);
          continue;
        }

        throw new Error(`HubSpot API error ${response.status}: ${errorMessage}`);
      }

      if (response.status === 204) return { success: true };

      return response.json();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry network errors on the last attempt
      if (attempt >= MAX_RETRIES) {
        break;
      }

      // Retry on network errors
      if (lastError.message.includes('fetch') || lastError.message.includes('network')) {
        const delay = getRetryDelay(attempt);
        await sleep(delay);
        continue;
      }

      // For other errors, don't retry unless it's a retriable status we handled above
      break;
    }
  }

  throw lastError || new Error('HubSpot API request failed after retries');
}

/**
 * Validate HubSpot credentials by making a real API call.
 */
export async function validateCredentials(context: ToolContext): Promise<void> {
  await hubspotRequest(context, '/integrations/v1/me', { skipRateLimit: true });
}

// =============================================================================
// FORMATTERS
// =============================================================================

/** Format a HubSpot contact for clean output. */
export function formatContact(contact: any) {
  const props = contact.properties || {};
  return {
    id: contact.id,
    email: props.email?.value ?? null,
    firstName: props.firstname?.value ?? null,
    lastName: props.lastname?.value ?? null,
    phone: props.phone?.value ?? null,
    company: props.company?.value ?? null,
    jobTitle: props.jobtitle?.value ?? null,
    website: props.website?.value ?? null,
    lifecycleStage: props.lifecyclestage?.value ?? null,
    leadStatus: props.hs_lead_status?.value ?? null,
    createdAt: props.createdate?.value ? new Date(parseInt(props.createdate.value)).toISOString() : null,
    updatedAt: props.lastmodifieddate?.value ? new Date(parseInt(props.lastmodifieddate.value)).toISOString() : null,
    url: `https://app.hubspot.com/contacts/${contact.id}`,
  };
}

/** Format a HubSpot company for clean output. */
export function formatCompany(company: any) {
  const props = company.properties || {};
  return {
    id: company.id,
    name: props.name?.value ?? null,
    domain: props.domain?.value ?? null,
    industry: props.industry?.value ?? null,
    type: props.type?.value ?? null,
    phone: props.phone?.value ?? null,
    website: props.website?.value ?? null,
    city: props.city?.value ?? null,
    state: props.state?.value ?? null,
    country: props.country?.value ?? null,
    numberOfEmployees: props.numberofemployees?.value ?? null,
    annualRevenue: props.annualrevenue?.value ?? null,
    lifecycleStage: props.lifecyclestage?.value ?? null,
    createdAt: props.createdate?.value ? new Date(parseInt(props.createdate.value)).toISOString() : null,
    updatedAt: props.hs_lastmodifieddate?.value ? new Date(parseInt(props.hs_lastmodifieddate.value)).toISOString() : null,
    url: `https://app.hubspot.com/contacts/${company.id}`,
  };
}

/** Format a HubSpot deal for clean output. */
export function formatDeal(deal: any) {
  const props = deal.properties || {};
  return {
    id: deal.id,
    name: props.dealname?.value ?? null,
    amount: props.amount?.value ? parseFloat(props.amount.value) : null,
    stage: props.dealstage?.value ?? null,
    pipeline: props.pipeline?.value ?? null,
    type: props.dealtype?.value ?? null,
    closeDate: props.closedate?.value ?? null,
    probability: props.probability?.value ?? null,
    description: props.description?.value ?? null,
    source: props.hs_analytics_source?.value ?? null,
    createdAt: props.createdate?.value ? new Date(parseInt(props.createdate.value)).toISOString() : null,
    updatedAt: props.hs_lastmodifieddate?.value ? new Date(parseInt(props.hs_lastmodifieddate.value)).toISOString() : null,
    url: `https://app.hubspot.com/contacts/${deal.id}`,
  };
}

/** Format a HubSpot ticket for clean output. */
export function formatTicket(ticket: any) {
  const props = ticket.properties || {};
  return {
    id: ticket.id,
    subject: props.subject?.value ?? null,
    content: props.content?.value ?? null,
    status: props.hs_ticket_priority?.value ?? null,
    priority: props.hs_pipeline_stage?.value ?? null,
    category: props.hs_ticket_category?.value ?? null,
    pipeline: props.hs_pipeline?.value ?? null,
    stage: props.hs_pipeline_stage?.value ?? null,
    source: props.source_type?.value ?? null,
    createdAt: props.createdate?.value ? new Date(parseInt(props.createdate.value)).toISOString() : null,
    updatedAt: props.hs_lastmodifieddate?.value ? new Date(parseInt(props.hs_lastmodifieddate.value)).toISOString() : null,
    url: `https://app.hubspot.com/contacts/${ticket.id}`,
  };
}

/** Format a HubSpot task (engagement) for clean output. */
export function formatTask(task: any) {
  const props = task.properties || {};
  return {
    id: task.id,
    subject: props.hs_task_subject?.value ?? null,
    body: props.hs_task_body?.value ?? null,
    status: props.hs_task_status?.value ?? null,
    priority: props.hs_task_priority?.value ?? null,
    type: props.hs_task_type?.value ?? null,
    dueDate: props.hs_timestamp?.value ?? null,
    reminder: props.hs_reminders?.value ?? null,
    createdAt: props.hs_createdate?.value ? new Date(parseInt(props.hs_createdate.value)).toISOString() : null,
    updatedAt: props.hs_lastmodifieddate?.value ? new Date(parseInt(props.hs_lastmodifieddate.value)).toISOString() : null,
  };
}

/** Format a HubSpot engagement (call, email, meeting, note) for clean output. */
export function formatEngagement(engagement: any) {
  const props = engagement.properties || {};
  return {
    id: engagement.id,
    type: props.hs_engagement_type?.value ?? engagement.properties?.hs_activity_type?.value ?? null,
    subject: props.hs_email_subject?.value ?? props.hs_call_title?.value ?? props.hs_meeting_title?.value ?? props.hs_note_body?.value ?? null,
    body: props.hs_email_text?.value ?? props.hs_call_body?.value ?? props.hs_meeting_body?.value ?? props.hs_note_body?.value ?? null,
    status: props.hs_email_status?.value ?? props.hs_call_status?.value ?? props.hs_meeting_status?.value ?? null,
    direction: props.hs_email_direction?.value ?? props.hs_call_direction?.value ?? null,
    duration: props.hs_call_duration?.value ?? props.hs_meeting_end_time?.value ?? null,
    startTime: props.hs_timestamp?.value ?? props.hs_meeting_start_time?.value ?? null,
    createdAt: props.hs_createdate?.value ? new Date(parseInt(props.hs_createdate.value)).toISOString() : null,
    updatedAt: props.hs_lastmodifieddate?.value ? new Date(parseInt(props.hs_lastmodifieddate.value)).toISOString() : null,
  };
}

/** Format a HubSpot list for clean output. */
export function formatList(list: any) {
  // CRM Lists v3 shape. `size` llega en additionalProperties.hs_list_size desde
  // /search, o como `size` en get-by-id. processingType: MANUAL|STATIC|DYNAMIC|
  // SNAPSHOT (la doc de HubSpot es inconsistente: STATIC en /search, MANUAL en
  // create — toleramos los cuatro). listId es string en v3.
  const processingType = list.processingType ?? null;
  const rawSize = list.additionalProperties?.hs_list_size ?? list.size;
  return {
    id: String(list.listId ?? list.id ?? ''),
    name: list.name ?? null,
    processingType,
    dynamic: processingType === 'DYNAMIC',
    objectTypeId: list.objectTypeId ?? null,
    createdAt: list.createdAt ?? null,
    updatedAt: list.updatedAt ?? null,
    memberCount: rawSize != null ? Number(rawSize) : null,
  };
}

/** Format a HubSpot pipeline for clean output. */
export function formatPipeline(pipeline: any) {
  return {
    id: pipeline.id,
    label: pipeline.label,
    displayOrder: pipeline.displayOrder,
    active: pipeline.active,
    stages: (pipeline.stages || []).map((stage: any) => ({
      id: stage.id,
      label: stage.label,
      displayOrder: stage.displayOrder,
      metadata: stage.metadata,
    })),
    createdAt: pipeline.createdAt,
    updatedAt: pipeline.updatedAt,
  };
}

/** Format a HubSpot association for clean output. */
export function formatAssociation(association: any) {
  return {
    id: association.id,
    fromObjectType: association.fromObjectType,
    fromObjectId: association.fromObjectId,
    toObjectType: association.toObjectType,
    toObjectId: association.toObjectId,
    associationType: association.associationType,
    associationCategory: association.associationCategory,
    associationTypeId: association.associationTypeId,
  };
}

/** Format a HubSpot conversation (inbox) for clean output. */
export function formatConversation(conversation: any) {
  return {
    id: conversation.id,
    status: conversation.status,
    channelId: conversation.channelId,
    channelAccountId: conversation.channelAccountId,
    createdAt: conversation.createdAt ? new Date(conversation.createdAt).toISOString() : null,
    updatedAt: conversation.updatedAt ? new Date(conversation.updatedAt).toISOString() : null,
    latestMessageTimestamp: conversation.latestMessageTimestamp
      ? new Date(conversation.latestMessageTimestamp).toISOString()
      : null,
  };
}

/** Format a HubSpot conversation message for clean output. */
export function formatConversationMessage(message: any) {
  return {
    id: message.id,
    type: message.type,
    text: message.text,
    sender: message.sender ? {
      actorId: message.sender.actorId,
      actorType: message.sender.actorType,
      name: message.sender.name,
      email: message.sender.email,
    } : null,
    recipients: message.recipients || [],
    createdAt: message.createdAt ? new Date(message.createdAt).toISOString() : null,
    attachments: message.attachments || [],
  };
}

// =============================================================================
// BUILDERS
// =============================================================================

/** Build properties payload for HubSpot create/update requests. */
export function buildProperties(payload: Record<string, any>): { properties: Record<string, string> } {
  const properties: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined && value !== null) {
      properties[key] = String(value);
    }
  }
  return { properties };
}

/** Build associations payload for HubSpot v4 API. */
export function buildAssociations(
  toObjectType: string,
  toObjectIds: string[],
  associationType?: string,
): { associations: Array<{ to: { id: string }; types: Array<{ associationCategory: string; associationTypeId: number | string }> }> } {
  return {
    associations: toObjectIds.map((id) => ({
      to: { id },
      types: associationType
        ? [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: associationType }]
        : [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 1 }],
    })),
  };
}
