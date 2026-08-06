#!/usr/bin/env npx tsx

/**
 * Google Analytics 4 MCA
 *
 * GA4 Data API + Admin API integration using McaServer with HTTP transport.
 * Secrets are fetched on-demand from backend via callbackUrl.
 *
 * Deployment: per-app (each installed app gets its own process)
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { google } from 'googleapis';
import type { analyticsdata_v1beta } from 'googleapis';
import {
  accountIdOf,
  buildReportRequest,
  classifyAccountsProbe,
  curateReport,
  mapAnalyticsError,
  parseAccountName,
  parsePropertyName,
  parseStreamId,
  pick,
  propertyIdOf,
  type RawReportArgs,
} from './helpers';

interface AnalyticsSecrets {
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
  REDIRECT_URIS?: string;
  ACCESS_TOKEN?: string;
  REFRESH_TOKEN?: string;
  EMAIL?: string;
  EXPIRY_DATE?: string;
}

// =============================================================================
// CLIENT FACTORY
// =============================================================================

async function createAnalyticsClients(secrets: AnalyticsSecrets) {
  const clientId = secrets.CLIENT_ID;
  const clientSecret = secrets.CLIENT_SECRET;
  const redirectUrisRaw = secrets.REDIRECT_URIS;

  if (!clientId || !clientSecret) {
    throw new Error(
      '[SYSTEM_CONFIG_MISSING] Google OAuth credentials not configured. Missing CLIENT_ID or CLIENT_SECRET.',
    );
  }

  let redirectUri = 'https://be.teros.ai/auth/callback';
  if (redirectUrisRaw) {
    try {
      const uris = JSON.parse(redirectUrisRaw);
      redirectUri = Array.isArray(uris) ? uris[0] : redirectUrisRaw;
    } catch {
      redirectUri = redirectUrisRaw;
    }
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  const accessToken = secrets.ACCESS_TOKEN;
  const refreshToken = secrets.REFRESH_TOKEN;
  const expiryDate = secrets.EXPIRY_DATE ? Number.parseInt(secrets.EXPIRY_DATE, 10) : undefined;

  if (!accessToken || !refreshToken) {
    throw new Error('[AUTH_REQUIRED] Google account not connected. Please connect your Google account.');
  }

  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
    expiry_date: expiryDate,
  });

  const needsRefresh = !accessToken || (expiryDate && expiryDate < Date.now() + 60_000);
  if (needsRefresh && refreshToken) {
    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);
    } catch (error: any) {
      throw new Error(`[AUTH_EXPIRED] Failed to refresh token: ${error.message}`);
    }
  }

  return {
    data: google.analyticsdata({ version: 'v1beta', auth: oauth2Client }),
    admin: google.analyticsadmin({ version: 'v1beta', auth: oauth2Client }),
    email: secrets.EMAIL || 'unknown@gmail.com',
  };
}

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.google.analytics',
  name: 'Google Analytics',
  version: '1.0.0',
});

// -----------------------------------------------------------------------------
// Health Check
// -----------------------------------------------------------------------------

server.tool('-health-check', {
  description: 'Internal health check. Verifies OAuth credentials and GA4 API connectivity.',
  parameters: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder().setVersion('1.0.0').setUptime(Math.floor(process.uptime()));

    try {
      const secrets = {
        ...(await context.getSystemSecrets()),
        ...(await context.getUserSecrets()),
      } as AnalyticsSecrets;

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

      if (!secrets.ACCESS_TOKEN || !secrets.REFRESH_TOKEN) {
        builder.addIssue('AUTH_REQUIRED', 'Google account not connected', {
          type: 'user_action',
          description: 'Connect your Google account to use Analytics',
        });
      } else {
        // Probe the Admin API once. `classifyAccountsProbe` owns the decision
        // for both outcomes (account count + error), so a quota 403 is NOT
        // flattened to AUTH_EXPIRED and the logic is unit-tested in isolation.
        try {
          const { admin } = await createAnalyticsClients(secrets);
          const probe = await admin.accounts.list({ pageSize: 1 });
          const issue = classifyAccountsProbe({ accountCount: probe.data.accounts?.length ?? 0 });
          if (issue) builder.addIssue(issue.code, issue.message, issue.action);
        } catch (apiError) {
          const issue = classifyAccountsProbe({ error: apiError });
          if (issue) builder.addIssue(issue.code, issue.message, issue.action);
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
// Admin: List Accounts
// -----------------------------------------------------------------------------

server.tool('analytics-list-accounts', {
  description:
    'List GA4 accounts accessible to the user. Returns { accounts: [{ accountId, name, displayName, regionCode, createTime }], count }.',
  parameters: {
    type: 'object',
    properties: {
      pageSize: { type: 'number', description: 'Max results per page (default 50, max 200)' },
      pageToken: { type: 'string', description: 'Pagination token from previous response' },
    },
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as AnalyticsSecrets;
    const { admin, email } = await createAnalyticsClients(secrets);

    try {
      const response = await admin.accounts.list({
        pageSize: (args.pageSize as number) || 50,
        pageToken: args.pageToken as string | undefined,
      });
      const accounts = (response.data.accounts || []).map((a: any) => ({
        accountId: accountIdOf(a.name),
        name: a.name,
        displayName: a.displayName,
        regionCode: a.regionCode,
        createTime: a.createTime,
        updateTime: a.updateTime,
      }));
      return {
        account: email,
        count: accounts.length,
        accounts,
        nextPageToken: response.data.nextPageToken,
      };
    } catch (err) {
      mapAnalyticsError(err);
    }
  },
});

// -----------------------------------------------------------------------------
// Admin: List Properties
// -----------------------------------------------------------------------------

server.tool('analytics-list-properties', {
  description:
    'List GA4 properties under an account. Returns { properties: [{ propertyId, displayName, propertyType, currencyCode, timeZone, industryCategory }], count }.',
  parameters: {
    type: 'object',
    properties: {
      accountId: {
        type: 'string',
        description: 'GA4 account ID (numeric or "accounts/{id}")',
      },
      pageSize: { type: 'number', description: 'Max results per page (default 50, max 200)' },
      pageToken: { type: 'string', description: 'Pagination token from previous response' },
      showDeleted: {
        type: 'boolean',
        description: 'Include soft-deleted properties (default false)',
      },
    },
    required: ['accountId'],
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as AnalyticsSecrets;
    const { admin, email } = await createAnalyticsClients(secrets);

    const account = parseAccountName(args.accountId as string);
    try {
      const response = await admin.properties.list({
        filter: `parent:${account}`,
        pageSize: (args.pageSize as number) || 50,
        pageToken: args.pageToken as string | undefined,
        showDeleted: (args.showDeleted as boolean) || false,
      });
      const properties = (response.data.properties || []).map((p: any) => ({
        propertyId: propertyIdOf(p.name),
        name: p.name,
        displayName: p.displayName,
        propertyType: p.propertyType,
        parent: p.parent,
        timeZone: p.timeZone,
        currencyCode: p.currencyCode,
        industryCategory: p.industryCategory,
        serviceLevel: p.serviceLevel,
        createTime: p.createTime,
        updateTime: p.updateTime,
        deleteTime: p.deleteTime,
      }));
      return {
        account: email,
        count: properties.length,
        properties,
        nextPageToken: response.data.nextPageToken,
      };
    } catch (err) {
      mapAnalyticsError(err);
    }
  },
});

// -----------------------------------------------------------------------------
// Admin: Get Property
// -----------------------------------------------------------------------------

server.tool('analytics-get-property', {
  description:
    'Get a GA4 property\'s details. Returns { property: { propertyId, displayName, propertyType, parent, timeZone, currencyCode, industryCategory, serviceLevel, createTime, updateTime } }.',
  parameters: {
    type: 'object',
    properties: {
      propertyId: {
        type: 'string',
        description: 'GA4 property ID (numeric or "properties/{id}")',
      },
    },
    required: ['propertyId'],
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as AnalyticsSecrets;
    const { admin, email } = await createAnalyticsClients(secrets);

    const name = parsePropertyName(args.propertyId as string);
    try {
      const response = await admin.properties.get({ name });
      const p = response.data;
      return {
        account: email,
        property: {
          propertyId: propertyIdOf(p.name),
          name: p.name,
          displayName: p.displayName,
          propertyType: p.propertyType,
          parent: p.parent,
          timeZone: p.timeZone,
          currencyCode: p.currencyCode,
          industryCategory: p.industryCategory,
          serviceLevel: p.serviceLevel,
          account: p.account,
          createTime: p.createTime,
          updateTime: p.updateTime,
          deleteTime: p.deleteTime,
        },
      };
    } catch (err) {
      mapAnalyticsError(err);
    }
  },
});

// -----------------------------------------------------------------------------
// Admin: List Data Streams
// -----------------------------------------------------------------------------

server.tool('analytics-list-data-streams', {
  description:
    'List data streams (web/iOS/Android) for a property. Returns { streams: [{ streamId, displayName, type, webStreamData, androidAppStreamData, iosAppStreamData }], count }.',
  parameters: {
    type: 'object',
    properties: {
      propertyId: {
        type: 'string',
        description: 'GA4 property ID (numeric or "properties/{id}")',
      },
      pageSize: { type: 'number', description: 'Max results per page (default 50)' },
      pageToken: { type: 'string', description: 'Pagination token from previous response' },
    },
    required: ['propertyId'],
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as AnalyticsSecrets;
    const { admin, email } = await createAnalyticsClients(secrets);

    const parent = parsePropertyName(args.propertyId as string);
    try {
      const response = await admin.properties.dataStreams.list({
        parent,
        pageSize: (args.pageSize as number) || 50,
        pageToken: args.pageToken as string | undefined,
      });
      const streams = (response.data.dataStreams || []).map((s: any) => ({
        streamId: s.name?.split('/').pop(),
        name: s.name,
        displayName: s.displayName,
        type: s.type,
        webStreamData: s.webStreamData
          ? pick(s.webStreamData, ['measurementId', 'firebaseAppId', 'defaultUri'])
          : undefined,
        androidAppStreamData: s.androidAppStreamData
          ? pick(s.androidAppStreamData, ['firebaseAppId', 'packageName'])
          : undefined,
        iosAppStreamData: s.iosAppStreamData
          ? pick(s.iosAppStreamData, ['firebaseAppId', 'bundleId'])
          : undefined,
        createTime: s.createTime,
        updateTime: s.updateTime,
      }));
      return {
        account: email,
        count: streams.length,
        streams,
        nextPageToken: response.data.nextPageToken,
      };
    } catch (err) {
      mapAnalyticsError(err);
    }
  },
});

// -----------------------------------------------------------------------------
// Admin: Get Data Stream
// -----------------------------------------------------------------------------

server.tool('analytics-get-data-stream', {
  description:
    'Get a single data stream\'s details. Returns { stream: { streamId, displayName, type, webStreamData?, androidAppStreamData?, iosAppStreamData? } }.',
  parameters: {
    type: 'object',
    properties: {
      propertyId: {
        type: 'string',
        description: 'GA4 property ID (numeric or "properties/{id}")',
      },
      streamId: { type: 'string', description: 'Data stream ID (numeric)' },
    },
    required: ['propertyId', 'streamId'],
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as AnalyticsSecrets;
    const { admin, email } = await createAnalyticsClients(secrets);

    const property = parsePropertyName(args.propertyId as string);
    const streamId = parseStreamId(args.streamId as string);
    const name = `${property}/dataStreams/${streamId}`;
    try {
      const response = await admin.properties.dataStreams.get({ name });
      const s = response.data;
      return {
        account: email,
        stream: {
          streamId: s.name?.split('/').pop(),
          name: s.name,
          displayName: s.displayName,
          type: s.type,
          webStreamData: s.webStreamData
            ? pick(s.webStreamData, ['measurementId', 'firebaseAppId', 'defaultUri'])
            : undefined,
          androidAppStreamData: s.androidAppStreamData
            ? pick(s.androidAppStreamData, ['firebaseAppId', 'packageName'])
            : undefined,
          iosAppStreamData: s.iosAppStreamData
            ? pick(s.iosAppStreamData, ['firebaseAppId', 'bundleId'])
            : undefined,
          createTime: s.createTime,
          updateTime: s.updateTime,
        },
      };
    } catch (err) {
      mapAnalyticsError(err);
    }
  },
});

// -----------------------------------------------------------------------------
// Data: Run Report
// -----------------------------------------------------------------------------

server.tool('analytics-run-report', {
  description:
    'Run a GA4 report. Returns { dimensionHeaders, metricHeaders, rows, rowCount, totals?, metadata, propertyQuota? }. Dates accept ISO ("2024-01-01") or relative ("7daysAgo", "yesterday", "today").',
  parameters: {
    type: 'object',
    properties: {
      propertyId: {
        type: 'string',
        description: 'GA4 property ID (numeric or "properties/{id}")',
      },
      dimensions: {
        type: 'array',
        description: 'Dimension API names, e.g. ["country", "deviceCategory"]',
        items: { type: 'string' },
      },
      metrics: {
        type: 'array',
        description: 'Metric API names, e.g. ["activeUsers", "sessions"]',
        items: { type: 'string' },
      },
      dateRanges: {
        type: 'array',
        description: 'Date ranges, e.g. [{ "startDate": "7daysAgo", "endDate": "yesterday" }]',
        items: {
          type: 'object',
          properties: {
            startDate: { type: 'string' },
            endDate: { type: 'string' },
            name: { type: 'string' },
          },
          required: ['startDate', 'endDate'],
        },
      },
      dimensionFilter: {
        type: 'object',
        description: 'GA4 FilterExpression for dimensions (see GA4 Data API docs)',
      },
      metricFilter: {
        type: 'object',
        description: 'GA4 FilterExpression for metrics (applied after aggregation)',
      },
      orderBys: {
        type: 'array',
        description: 'Order by config, e.g. [{ "metric": { "metricName": "sessions" }, "desc": true }]',
        items: { type: 'object' },
      },
      limit: { type: 'number', description: 'Max rows (default 10000, max 250000)' },
      offset: { type: 'number', description: 'Row offset (default 0)' },
      keepEmptyRows: { type: 'boolean', description: 'Include rows where all metrics are zero' },
      returnPropertyQuota: { type: 'boolean', description: 'Include quota info in response' },
      currencyCode: { type: 'string', description: 'ISO 4217 currency override (e.g. "USD")' },
      metricAggregations: {
        type: 'array',
        description: 'Aggregations: TOTAL, MINIMUM, MAXIMUM',
        items: { type: 'string' },
      },
    },
    required: ['propertyId', 'metrics', 'dateRanges'],
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as AnalyticsSecrets;
    const { data, email } = await createAnalyticsClients(secrets);

    const property = parsePropertyName(args.propertyId as string);
    // Normalization (dims/metrics → [{name}], limit/offset → string, required
    // checks) is owned by the shared, pure `buildReportRequest`. Validation
    // throws propagate raw (outside the try) — they are not API errors.
    const requestBody = buildReportRequest(
      args as unknown as RawReportArgs,
    ) as analyticsdata_v1beta.Schema$RunReportRequest;

    try {
      const response = await data.properties.runReport({ property, requestBody });
      return {
        account: email,
        propertyId: propertyIdOf(property),
        ...curateReport(response.data),
      };
    } catch (err) {
      mapAnalyticsError(err);
    }
  },
});

// -----------------------------------------------------------------------------
// Data: Batch Run Reports
// -----------------------------------------------------------------------------

server.tool('analytics-batch-run-reports', {
  description:
    'Run up to 5 GA4 reports against the same property in one call. Returns { reports: [<RunReportResponse>...] }. Useful for dashboards.',
  parameters: {
    type: 'object',
    properties: {
      propertyId: {
        type: 'string',
        description: 'GA4 property ID (numeric or "properties/{id}")',
      },
      requests: {
        type: 'array',
        description: 'Array of report requests (same shape as analytics-run-report parameters minus propertyId)',
        items: { type: 'object' },
      },
    },
    required: ['propertyId', 'requests'],
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as AnalyticsSecrets;
    const { data, email } = await createAnalyticsClients(secrets);

    const property = parsePropertyName(args.propertyId as string);
    const requests = args.requests as Array<unknown>;
    if (!Array.isArray(requests) || !requests.length) {
      throw new Error('[INVALID_ARGUMENT] requests must be a non-empty array');
    }
    if (requests.length > 5) {
      throw new Error('[INVALID_ARGUMENT] at most 5 requests per batch');
    }
    // Normalize EACH sub-request through the same builder as run-report.
    // GA4 requires `metrics`/`dimensions` as `[{name}]`; forwarding the raw
    // strings produced a 400 INVALID_ARGUMENT in batch's documented use.
    const normalizedRequests = requests.map(
      (r) => buildReportRequest(r as RawReportArgs),
    ) as analyticsdata_v1beta.Schema$RunReportRequest[];

    try {
      const response = await data.properties.batchRunReports({
        property,
        requestBody: { requests: normalizedRequests },
      });
      const reports = (response.data.reports || []).map(curateReport);
      return {
        account: email,
        propertyId: propertyIdOf(property),
        count: reports.length,
        reports,
      };
    } catch (err) {
      mapAnalyticsError(err);
    }
  },
});

// -----------------------------------------------------------------------------
// Data: Run Realtime Report
// -----------------------------------------------------------------------------

server.tool('analytics-run-realtime-report', {
  description:
    'Run a GA4 realtime report (last 30 minutes of activity). Returns { dimensionHeaders, metricHeaders, rows, rowCount, propertyQuota? }.',
  parameters: {
    type: 'object',
    properties: {
      propertyId: {
        type: 'string',
        description: 'GA4 property ID (numeric or "properties/{id}")',
      },
      dimensions: {
        type: 'array',
        description: 'Realtime dimension API names, e.g. ["country", "unifiedScreenName"]',
        items: { type: 'string' },
      },
      metrics: {
        type: 'array',
        description: 'Realtime metric API names, e.g. ["activeUsers"]',
        items: { type: 'string' },
      },
      dimensionFilter: { type: 'object', description: 'FilterExpression for dimensions' },
      metricFilter: { type: 'object', description: 'FilterExpression for metrics' },
      orderBys: { type: 'array', description: 'Order by config', items: { type: 'object' } },
      limit: { type: 'number', description: 'Max rows (default 10000)' },
      returnPropertyQuota: { type: 'boolean', description: 'Include quota info in response' },
    },
    required: ['propertyId', 'metrics'],
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as AnalyticsSecrets;
    const { data, email } = await createAnalyticsClients(secrets);

    const property = parsePropertyName(args.propertyId as string);
    // Same shared builder, realtime mode: no dateRanges/offset/currencyCode/
    // metricAggregations, but identical dims/metrics normalization + metrics
    // required check.
    const requestBody = buildReportRequest(args as unknown as RawReportArgs, {
      realtime: true,
    }) as analyticsdata_v1beta.Schema$RunRealtimeReportRequest;

    try {
      const response = await data.properties.runRealtimeReport({ property, requestBody });
      return {
        account: email,
        propertyId: propertyIdOf(property),
        ...curateReport(response.data),
      };
    } catch (err) {
      mapAnalyticsError(err);
    }
  },
});

// -----------------------------------------------------------------------------
// Data: Get Metadata (custom dimensions/metrics for property)
// -----------------------------------------------------------------------------

server.tool('analytics-get-metadata', {
  description:
    'Get all dimensions and metrics available for a property, including custom ones. Returns { dimensions: [{ apiName, uiName, description, customDefinition }], metrics: [{ apiName, uiName, description, type, customDefinition }] }.',
  parameters: {
    type: 'object',
    properties: {
      propertyId: {
        type: 'string',
        description: 'GA4 property ID (numeric or "properties/{id}")',
      },
    },
    required: ['propertyId'],
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as AnalyticsSecrets;
    const { data, email } = await createAnalyticsClients(secrets);

    const property = parsePropertyName(args.propertyId as string);
    try {
      const response = await data.properties.getMetadata({ name: `${property}/metadata` });
      const dims = (response.data.dimensions || []).map((d: any) => ({
        apiName: d.apiName,
        uiName: d.uiName,
        description: d.description,
        category: d.category,
        customDefinition: d.customDefinition || false,
        deprecatedApiNames: d.deprecatedApiNames,
      }));
      const mets = (response.data.metrics || []).map((m: any) => ({
        apiName: m.apiName,
        uiName: m.uiName,
        description: m.description,
        type: m.type,
        category: m.category,
        customDefinition: m.customDefinition || false,
        expression: m.expression,
        deprecatedApiNames: m.deprecatedApiNames,
      }));
      return {
        account: email,
        propertyId: propertyIdOf(property),
        dimensionsCount: dims.length,
        metricsCount: mets.length,
        dimensions: dims,
        metrics: mets,
      };
    } catch (err) {
      mapAnalyticsError(err);
    }
  },
});

// -----------------------------------------------------------------------------
// Admin: Create Property
// -----------------------------------------------------------------------------

server.tool('analytics-create-property', {
  description:
    'Create a new GA4 property under an account. Returns { property: { propertyId, displayName, parent, timeZone, currencyCode, ... } }.',
  parameters: {
    type: 'object',
    properties: {
      accountId: {
        type: 'string',
        description: 'GA4 account ID (numeric or "accounts/{id}")',
      },
      displayName: { type: 'string', description: 'Human-readable property name' },
      timeZone: { type: 'string', description: 'IANA time zone, e.g. "America/Los_Angeles"' },
      currencyCode: { type: 'string', description: 'ISO 4217 currency, e.g. "USD"' },
      industryCategory: {
        type: 'string',
        description: 'GA4 industry enum, e.g. "TECHNOLOGY", "RETAIL", "FINANCE"',
      },
    },
    required: ['accountId', 'displayName', 'timeZone'],
  },
  annotations: { readOnlyHint: false, openWorldHint: true },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as AnalyticsSecrets;
    const { admin, email } = await createAnalyticsClients(secrets);

    const account = parseAccountName(args.accountId as string);
    const displayName = String(args.displayName || '').trim();
    const timeZone = String(args.timeZone || '').trim();
    if (!displayName) throw new Error('[INVALID_ARGUMENT] displayName must be a non-empty string');
    if (!timeZone) throw new Error('[INVALID_ARGUMENT] timeZone must be a non-empty IANA time zone');

    try {
      const response = await admin.properties.create({
        requestBody: {
          parent: account,
          displayName,
          timeZone,
          currencyCode: (args.currencyCode as string) || undefined,
          industryCategory: (args.industryCategory as string) || undefined,
        },
      });
      const p = response.data;
      return {
        account: email,
        property: {
          propertyId: propertyIdOf(p.name),
          name: p.name,
          displayName: p.displayName,
          parent: p.parent,
          propertyType: p.propertyType,
          timeZone: p.timeZone,
          currencyCode: p.currencyCode,
          industryCategory: p.industryCategory,
          serviceLevel: p.serviceLevel,
          createTime: p.createTime,
        },
      };
    } catch (err) {
      mapAnalyticsError(err);
    }
  },
});

// -----------------------------------------------------------------------------
// Admin: Update Property
// -----------------------------------------------------------------------------

server.tool('analytics-update-property', {
  description:
    'Update mutable fields of a GA4 property (displayName, timeZone, currencyCode, industryCategory). Returns { property: <updated> }.',
  parameters: {
    type: 'object',
    properties: {
      propertyId: {
        type: 'string',
        description: 'GA4 property ID (numeric or "properties/{id}")',
      },
      displayName: { type: 'string', description: 'New display name' },
      timeZone: { type: 'string', description: 'New IANA time zone' },
      currencyCode: { type: 'string', description: 'New ISO 4217 currency code' },
      industryCategory: { type: 'string', description: 'New industry enum' },
    },
    required: ['propertyId'],
  },
  annotations: { readOnlyHint: false, openWorldHint: true },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as AnalyticsSecrets;
    const { admin, email } = await createAnalyticsClients(secrets);

    const name = parsePropertyName(args.propertyId as string);
    const updates: Record<string, any> = {};
    const mask: string[] = [];
    if (typeof args.displayName === 'string' && args.displayName.trim()) {
      updates.displayName = args.displayName.trim();
      mask.push('displayName');
    }
    if (typeof args.timeZone === 'string' && args.timeZone.trim()) {
      updates.timeZone = args.timeZone.trim();
      mask.push('timeZone');
    }
    if (typeof args.currencyCode === 'string' && args.currencyCode.trim()) {
      updates.currencyCode = args.currencyCode.trim();
      mask.push('currencyCode');
    }
    if (typeof args.industryCategory === 'string' && args.industryCategory.trim()) {
      updates.industryCategory = args.industryCategory.trim();
      mask.push('industryCategory');
    }
    if (!mask.length) {
      throw new Error('[INVALID_ARGUMENT] at least one of displayName, timeZone, currencyCode, industryCategory must be provided');
    }

    try {
      const response = await admin.properties.patch({
        name,
        updateMask: mask.join(','),
        requestBody: updates,
      });
      const p = response.data;
      return {
        account: email,
        property: {
          propertyId: propertyIdOf(p.name),
          name: p.name,
          displayName: p.displayName,
          parent: p.parent,
          timeZone: p.timeZone,
          currencyCode: p.currencyCode,
          industryCategory: p.industryCategory,
          updateTime: p.updateTime,
        },
        updatedFields: mask,
      };
    } catch (err) {
      mapAnalyticsError(err);
    }
  },
});

// -----------------------------------------------------------------------------
// Admin: Delete Property (soft-delete; recoverable for ~7 days)
// -----------------------------------------------------------------------------

server.tool('analytics-delete-property', {
  description:
    'Soft-delete a GA4 property (recoverable for ~7 days from Google Analytics UI). Returns { property: { propertyId, deleteTime, ... } }.',
  parameters: {
    type: 'object',
    properties: {
      propertyId: {
        type: 'string',
        description: 'GA4 property ID (numeric or "properties/{id}")',
      },
    },
    required: ['propertyId'],
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as AnalyticsSecrets;
    const { admin, email } = await createAnalyticsClients(secrets);

    const name = parsePropertyName(args.propertyId as string);
    try {
      const response = await admin.properties.delete({ name });
      const p = response.data;
      return {
        account: email,
        property: {
          propertyId: propertyIdOf(p.name),
          name: p.name,
          displayName: p.displayName,
          parent: p.parent,
          deleteTime: p.deleteTime,
          updateTime: p.updateTime,
        },
        recoverable: true,
        recoverableWindowDays: 7,
      };
    } catch (err) {
      mapAnalyticsError(err);
    }
  },
});

// -----------------------------------------------------------------------------
// Admin: Create Data Stream
// -----------------------------------------------------------------------------

server.tool('analytics-create-data-stream', {
  description:
    'Create a web/iOS/Android data stream under a property. Returns { stream: { streamId, displayName, type, webStreamData? } }.',
  parameters: {
    type: 'object',
    properties: {
      propertyId: {
        type: 'string',
        description: 'GA4 property ID (numeric or "properties/{id}")',
      },
      displayName: { type: 'string', description: 'Human-readable stream name' },
      type: {
        type: 'string',
        description: 'Stream type: WEB_DATA_STREAM | ANDROID_APP_DATA_STREAM | IOS_APP_DATA_STREAM',
      },
      webStreamData: {
        type: 'object',
        description: 'Required for WEB_DATA_STREAM: { defaultUri }',
        properties: { defaultUri: { type: 'string' } },
      },
      androidAppStreamData: {
        type: 'object',
        description: 'Required for ANDROID_APP_DATA_STREAM: { packageName }',
        properties: { packageName: { type: 'string' } },
      },
      iosAppStreamData: {
        type: 'object',
        description: 'Required for IOS_APP_DATA_STREAM: { bundleId }',
        properties: { bundleId: { type: 'string' } },
      },
    },
    required: ['propertyId', 'displayName', 'type'],
  },
  annotations: { readOnlyHint: false, openWorldHint: true },
  handler: async (args, context) => {
    const secrets = {
      ...(await context.getSystemSecrets()),
      ...(await context.getUserSecrets()),
    } as AnalyticsSecrets;
    const { admin, email } = await createAnalyticsClients(secrets);

    const parent = parsePropertyName(args.propertyId as string);
    const type = String(args.type || '').trim();
    const displayName = String(args.displayName || '').trim();
    if (!displayName) throw new Error('[INVALID_ARGUMENT] displayName must be a non-empty string');

    const validTypes = ['WEB_DATA_STREAM', 'ANDROID_APP_DATA_STREAM', 'IOS_APP_DATA_STREAM'];
    if (!validTypes.includes(type)) {
      throw new Error(`[INVALID_ARGUMENT] type must be one of: ${validTypes.join(', ')}`);
    }

    const requestBody: Record<string, any> = { displayName, type };
    if (type === 'WEB_DATA_STREAM') {
      const web = args.webStreamData as { defaultUri?: string } | undefined;
      if (!web?.defaultUri?.trim()) {
        throw new Error('[INVALID_ARGUMENT] webStreamData.defaultUri is required for WEB_DATA_STREAM');
      }
      try {
        const url = new URL(web.defaultUri.trim());
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          throw new Error('[INVALID_ARGUMENT] webStreamData.defaultUri must be http(s)');
        }
      } catch {
        throw new Error('[INVALID_ARGUMENT] webStreamData.defaultUri must be a valid URL');
      }
      requestBody.webStreamData = { defaultUri: web.defaultUri.trim() };
    }
    if (type === 'ANDROID_APP_DATA_STREAM') {
      const android = args.androidAppStreamData as { packageName?: string } | undefined;
      if (!android?.packageName?.trim()) {
        throw new Error(
          '[INVALID_ARGUMENT] androidAppStreamData.packageName is required for ANDROID_APP_DATA_STREAM',
        );
      }
      requestBody.androidAppStreamData = { packageName: android.packageName.trim() };
    }
    if (type === 'IOS_APP_DATA_STREAM') {
      const ios = args.iosAppStreamData as { bundleId?: string } | undefined;
      if (!ios?.bundleId?.trim()) {
        throw new Error('[INVALID_ARGUMENT] iosAppStreamData.bundleId is required for IOS_APP_DATA_STREAM');
      }
      requestBody.iosAppStreamData = { bundleId: ios.bundleId.trim() };
    }

    try {
      const response = await admin.properties.dataStreams.create({ parent, requestBody });
      const s = response.data;
      return {
        account: email,
        stream: {
          streamId: s.name?.split('/').pop(),
          name: s.name,
          displayName: s.displayName,
          type: s.type,
          webStreamData: s.webStreamData
            ? pick(s.webStreamData, ['measurementId', 'firebaseAppId', 'defaultUri'])
            : undefined,
          androidAppStreamData: s.androidAppStreamData
            ? pick(s.androidAppStreamData, ['firebaseAppId', 'packageName'])
            : undefined,
          iosAppStreamData: s.iosAppStreamData
            ? pick(s.iosAppStreamData, ['firebaseAppId', 'bundleId'])
            : undefined,
          createTime: s.createTime,
        },
      };
    } catch (err) {
      mapAnalyticsError(err);
    }
  },
});

// =============================================================================
// START SERVER
// =============================================================================

server.start();
