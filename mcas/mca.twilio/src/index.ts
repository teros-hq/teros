#!/usr/bin/env npx tsx

/**
 * Twilio MCA - Telephony Integration
 *
 * Features:
 * - Account info and balance monitoring
 * - Phone number management (list, search available, buy)
 * - SMS sending and message history
 * - Call history and details with recordings
 * - Standardized health check protocol
 *
 * Uses McaServer from @teros/mca-sdk for automatic transport detection.
 * Twilio API: https://www.twilio.com/docs/usage/api
 */

import { HealthCheckBuilder, McaServer } from '@teros/mca-sdk';
import { resolveCredentials, type TwilioCredentials } from './credentials';

// =============================================================================
// CONFIGURATION
// =============================================================================

const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';

// =============================================================================
// API HELPERS
// =============================================================================

/**
 * Make an authenticated request to the Twilio API.
 * Auth: HTTP Basic with AccountSid:AuthToken
 * Twilio returns XML by default; we request JSON via .json extension.
 */
async function twilioRequest(
  creds: TwilioCredentials,
  endpoint: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = `${TWILIO_API_BASE}/Accounts/${creds.accountSid}${endpoint}`;
  const auth = Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64');

  const headers: Record<string, string> = {
    Authorization: `Basic ${auth}`,
    Accept: 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };

  // POST requests to Twilio use form-encoded bodies
  if (options.body && typeof options.body === 'string' && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  return fetch(url, { ...options, headers });
}

/**
 * Parse a Twilio error response and throw a descriptive error.
 * Twilio errors: { code, message, more_info, status }
 * Common codes: 21211 (invalid number), 21614 (not SMS capable), 21421/21422 (area code unavailable)
 */
async function handleTwilioError(response: Response, action: string): Promise<never> {
  let errorMessage = `${action} failed (${response.status})`;
  try {
    const errorData = (await response.json()) as any;
    if (errorData.message) {
      errorMessage = `${action} failed: ${errorData.message}`;
      if (errorData.code) {
        errorMessage += ` (Twilio code ${errorData.code})`;
      }
    }
  } catch {
    errorMessage = `${action} failed: ${response.status} ${response.statusText}`;
  }
  throw new Error(errorMessage);
}

/**
 * Validate E.164 phone number format.
 */
function assertE164(phone: string, field: string): void {
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
    throw new Error(
      `${field} must be in E.164 format (e.g. +15551234567). Got: "${phone}"`,
    );
  }
}

// =============================================================================
// MCA SERVER
// =============================================================================

const server = new McaServer({
  id: 'mca.twilio',
  name: 'Twilio',
  version: '1.0.0',
});

// =============================================================================
// HEALTH CHECK
// =============================================================================

server.tool('-health-check', {
  annotations: { readOnlyHint: true },
  description: 'Internal health check tool. Verifies Twilio credentials and API connectivity.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const builder = new HealthCheckBuilder().setVersion('1.0.0');

    try {
      const creds = await resolveCredentials(context);

      if (!creds.accountSid || !creds.authToken) {
        builder.addIssue('SYSTEM_CONFIG_MISSING', 'Twilio credentials not configured', {
          type: 'admin_action',
          description:
            'Configure ACCOUNT_SID and AUTH_TOKEN in your user secrets (per-user account) or in system secrets (shared fallback)',
        });
      } else {
        try {
          const response = await twilioRequest(creds, '.json');

          if (!response.ok) {
            if (response.status === 401) {
              builder.addIssue('AUTH_INVALID', 'Twilio credentials are invalid', {
                type: 'admin_action',
                description: 'The configured ACCOUNT_SID/AUTH_TOKEN are invalid. Please update them.',
              });
            } else {
              builder.addIssue(
                'DEPENDENCY_UNAVAILABLE',
                `Twilio API error: ${response.status} ${response.statusText}`,
                {
                  type: 'auto_retry',
                  description: 'Twilio API temporarily unavailable',
                },
              );
            }
          }
        } catch (error: any) {
          builder.addIssue(
            'DEPENDENCY_UNAVAILABLE',
            `Failed to connect to Twilio: ${error.message}`,
            {
              type: 'auto_retry',
              description: 'Network error connecting to Twilio API',
            },
          );
        }
      }
    } catch (error: any) {
      builder.addIssue('SYSTEM_CONFIG_MISSING', `Failed to get secrets: ${error.message}`, {
        type: 'admin_action',
        description: 'Could not read user or system secrets',
      });
    }

    return builder.build();
  },
});

// =============================================================================
// ACCOUNT TOOLS
// =============================================================================

server.tool('get-account', {
  annotations: { readOnlyHint: true },
  description:
    'Get Twilio account information including friendly name, status, and current balance.',
  parameters: {
    type: 'object',
    properties: {},
  },
  handler: async (_args, context) => {
    const creds = await resolveCredentials(context);

    if (!creds.accountSid || !creds.authToken) {
      throw new Error('Twilio credentials not configured');
    }

    // Fetch account details and balance in parallel
    const [accountRes, balanceRes] = await Promise.all([
      twilioRequest(creds, '.json'),
      twilioRequest(creds, '/Balance.json'),
    ]);

    if (!accountRes.ok) {
      await handleTwilioError(accountRes, 'Get account');
    }
    if (!balanceRes.ok) {
      await handleTwilioError(balanceRes, 'Get balance');
    }

    const account = (await accountRes.json()) as any;
    const balance = (await balanceRes.json()) as any;

    return {
      account_sid: account.sid,
      friendly_name: account.friendly_name,
      status: account.status,
      type: account.type,
      date_created: account.date_created,
      balance: {
        amount: parseFloat(balance.balance),
        currency: balance.currency,
      },
    };
  },
});

// =============================================================================
// PHONE NUMBER TOOLS
// =============================================================================

server.tool('list-phone-numbers', {
  annotations: { readOnlyHint: true },
  description:
    'List all phone numbers owned by the Twilio account with their capabilities (voice, SMS, MMS, fax).',
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Maximum number of results (default: 50)',
        default: 50,
      },
    },
  },
  handler: async (args: any, context) => {
    const creds = await resolveCredentials(context);

    if (!creds.accountSid || !creds.authToken) {
      throw new Error('Twilio credentials not configured');
    }

    const limit = args.limit || 50;
    const response = await twilioRequest(creds, `/IncomingPhoneNumbers.json?PageSize=${limit}`);

    if (!response.ok) {
      await handleTwilioError(response, 'List phone numbers');
    }

    const data = (await response.json()) as any;
    const numbers = data.incoming_phone_numbers || [];

    return {
      total: numbers.length,
      phone_numbers: numbers.map((n: any) => ({
        sid: n.sid,
        phone_number: n.phone_number,
        friendly_name: n.friendly_name,
        capabilities: n.capabilities,
        status: n.status,
        date_created: n.date_created,
        voice_url: n.voice_url || null,
        sms_url: n.sms_url || null,
      })),
    };
  },
});

server.tool('list-available-numbers', {
  annotations: { readOnlyHint: true },
  description:
    'Search for available phone numbers to purchase in a given country. Optionally filter by area code and capabilities. Use this before buy-phone-number to see options and pricing.',
  parameters: {
    type: 'object',
    properties: {
      countryCode: {
        type: 'string',
        description: 'ISO 3166-1 alpha-2 country code (e.g. "US", "ES", "GB")',
      },
      areaCode: {
        type: 'string',
        description: 'Optional area code to filter by (e.g. "415" for San Francisco)',
      },
      smsEnabled: {
        type: 'boolean',
        description: 'Only show SMS-capable numbers (default: true)',
        default: true,
      },
      voiceEnabled: {
        type: 'boolean',
        description: 'Only show voice-capable numbers (default: false)',
        default: false,
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results (default: 10)',
        default: 10,
      },
    },
    required: ['countryCode'],
  },
  handler: async (args: any, context) => {
    const creds = await resolveCredentials(context);

    if (!creds.accountSid || !creds.authToken) {
      throw new Error('Twilio credentials not configured');
    }

    const country = args.countryCode.toUpperCase();
    const params = new URLSearchParams();

    if (args.areaCode) params.set('AreaCode', args.areaCode);
    if (args.smsEnabled !== false) params.set('SmsEnabled', 'true');
    if (args.voiceEnabled) params.set('VoiceEnabled', 'true');
    params.set('PageSize', String(args.limit || 10));

    const response = await twilioRequest(
      creds,
      `/AvailablePhoneNumbers/${country}/Local.json?${params.toString()}`,
    );

    if (!response.ok) {
      await handleTwilioError(response, `Search available numbers in ${country}`);
    }

    const data = (await response.json()) as any;
    const numbers = data.available_phone_numbers || [];

    return {
      country: country,
      total: numbers.length,
      available_numbers: numbers.map((n: any) => ({
        phone_number: n.phone_number,
        friendly_name: n.friendly_name,
        locality: n.locality,
        region: n.region,
        iso_country: n.iso_country,
        capabilities: n.capabilities,
      })),
    };
  },
});

server.tool('buy-phone-number', {
  annotations: { readOnlyHint: false },
  description:
    'Purchase a phone number from Twilio. IMPORTANT: This spends real money from the account balance — always confirm with the user before buying. Use list-available-numbers first to find options.',
  parameters: {
    type: 'object',
    properties: {
      phoneNumber: {
        type: 'string',
        description: 'The exact E.164 phone number to purchase (from list-available-numbers)',
      },
      friendlyName: {
        type: 'string',
        description: 'Optional friendly name for the number',
      },
      voiceUrl: {
        type: 'string',
        description: 'Optional webhook URL for incoming voice calls',
      },
      smsUrl: {
        type: 'string',
        description: 'Optional webhook URL for incoming SMS',
      },
    },
    required: ['phoneNumber'],
  },
  handler: async (args: any, context) => {
    const creds = await resolveCredentials(context);

    if (!creds.accountSid || !creds.authToken) {
      throw new Error('Twilio credentials not configured');
    }

    assertE164(args.phoneNumber, 'phoneNumber');

    const body = new URLSearchParams();
    body.set('PhoneNumber', args.phoneNumber);
    if (args.friendlyName) body.set('FriendlyName', args.friendlyName);
    if (args.voiceUrl) body.set('VoiceUrl', args.voiceUrl);
    if (args.smsUrl) body.set('SmsUrl', args.smsUrl);

    const response = await twilioRequest(creds, '/IncomingPhoneNumbers.json', {
      method: 'POST',
      body: body.toString(),
    });

    if (!response.ok) {
      await handleTwilioError(response, `Buy phone number ${args.phoneNumber}`);
    }

    const data = (await response.json()) as any;

    return {
      success: true,
      sid: data.sid,
      phone_number: data.phone_number,
      friendly_name: data.friendly_name,
      capabilities: data.capabilities,
      date_created: data.date_created,
    };
  },
});

// =============================================================================
// SMS TOOLS
// =============================================================================

server.tool('send-sms', {
  annotations: { readOnlyHint: false },
  description:
    'Send an SMS message from a Twilio phone number. The fromNumber must be a number owned by the account with SMS capability. Costs apply per message sent.',
  parameters: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: 'Destination phone number in E.164 format (e.g. +34600123456)',
      },
      fromNumber: {
        type: 'string',
        description: 'Twilio phone number to send from (E.164). Must have SMS capability.',
      },
      body: {
        type: 'string',
        description: 'Message text (up to 1600 characters)',
      },
    },
    required: ['to', 'fromNumber', 'body'],
  },
  handler: async (args: any, context) => {
    const creds = await resolveCredentials(context);

    if (!creds.accountSid || !creds.authToken) {
      throw new Error('Twilio credentials not configured');
    }

    assertE164(args.to, 'to');
    assertE164(args.fromNumber, 'fromNumber');

    if (!args.body || args.body.trim().length === 0) {
      throw new Error('Message body cannot be empty');
    }

    if (args.body.length > 1600) {
      throw new Error(`Message body too long: ${args.body.length} chars (max 1600)`);
    }

    const body = new URLSearchParams();
    body.set('To', args.to);
    body.set('From', args.fromNumber);
    body.set('Body', args.body);

    const response = await twilioRequest(creds, '/Messages.json', {
      method: 'POST',
      body: body.toString(),
    });

    if (!response.ok) {
      await handleTwilioError(response, `Send SMS to ${args.to}`);
    }

    const data = (await response.json()) as any;

    return {
      success: true,
      message_sid: data.sid,
      to: data.to,
      from: data.from,
      body: data.body,
      status: data.status,
      direction: data.direction,
      price: data.price,
      price_unit: data.price_unit,
      date_created: data.date_created,
    };
  },
});

server.tool('list-messages', {
  annotations: { readOnlyHint: true },
  description:
    'List SMS message history for the account. Can filter by sender, recipient, or date range.',
  parameters: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: 'Filter by recipient number (E.164)',
      },
      fromNumber: {
        type: 'string',
        description: 'Filter by sender number (E.164)',
      },
      dateSentAfter: {
        type: 'string',
        description: 'Filter messages sent after this date (YYYY-MM-DD)',
      },
      dateSentBefore: {
        type: 'string',
        description: 'Filter messages sent before this date (YYYY-MM-DD)',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results (default: 20)',
        default: 20,
      },
    },
  },
  handler: async (args: any, context) => {
    const creds = await resolveCredentials(context);

    if (!creds.accountSid || !creds.authToken) {
      throw new Error('Twilio credentials not configured');
    }

    const params = new URLSearchParams();
    if (args.to) params.set('To', args.to);
    if (args.fromNumber) params.set('From', args.fromNumber);
    if (args.dateSentAfter) params.set('DateSent>', args.dateSentAfter);
    if (args.dateSentBefore) params.set('DateSent<', args.dateSentBefore);
    params.set('PageSize', String(args.limit || 20));

    const response = await twilioRequest(creds, `/Messages.json?${params.toString()}`);

    if (!response.ok) {
      await handleTwilioError(response, 'List messages');
    }

    const data = (await response.json()) as any;
    const messages = data.messages || [];

    return {
      total: messages.length,
      messages: messages.map((m: any) => ({
        sid: m.sid,
        to: m.to,
        from: m.from,
        body: m.body,
        status: m.status,
        direction: m.direction,
        price: m.price,
        price_unit: m.price_unit,
        date_sent: m.date_sent,
        date_created: m.date_created,
        num_segments: m.num_segments,
        error_code: m.error_code || null,
        error_message: m.error_message || null,
      })),
    };
  },
});

// =============================================================================
// CALL TOOLS
// =============================================================================

server.tool('list-calls', {
  annotations: { readOnlyHint: true },
  description:
    'List call history for the account. Can filter by caller, recipient, status, or date range.',
  parameters: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: 'Filter by recipient number (E.164)',
      },
      fromNumber: {
        type: 'string',
        description: 'Filter by caller number (E.164)',
      },
      status: {
        type: 'string',
        description:
          'Filter by call status: queued, ringing, in-progress, completed, busy, failed, no-answer, canceled',
      },
      startTimeAfter: {
        type: 'string',
        description: 'Filter calls started after this date (YYYY-MM-DD)',
      },
      startTimeBefore: {
        type: 'string',
        description: 'Filter calls started before this date (YYYY-MM-DD)',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results (default: 20)',
        default: 20,
      },
    },
  },
  handler: async (args: any, context) => {
    const creds = await resolveCredentials(context);

    if (!creds.accountSid || !creds.authToken) {
      throw new Error('Twilio credentials not configured');
    }

    const params = new URLSearchParams();
    if (args.to) params.set('To', args.to);
    if (args.fromNumber) params.set('From', args.fromNumber);
    if (args.status) params.set('Status', args.status);
    if (args.startTimeAfter) params.set('StartTime>', args.startTimeAfter);
    if (args.startTimeBefore) params.set('StartTime<', args.startTimeBefore);
    params.set('PageSize', String(args.limit || 20));

    const response = await twilioRequest(creds, `/Calls.json?${params.toString()}`);

    if (!response.ok) {
      await handleTwilioError(response, 'List calls');
    }

    const data = (await response.json()) as any;
    const calls = data.calls || [];

    return {
      total: calls.length,
      calls: calls.map((c: any) => ({
        sid: c.sid,
        to: c.to,
        from: c.from,
        status: c.status,
        direction: c.direction,
        duration: c.duration ? parseInt(c.duration, 10) : null,
        start_time: c.start_time,
        end_time: c.end_time,
        price: c.price,
        price_unit: c.price_unit,
        answered_by: c.answered_by || null,
      })),
    };
  },
});

server.tool('get-call', {
  annotations: { readOnlyHint: true },
  description:
    'Get detailed information about a specific call, including duration, price, and recording URL if available.',
  parameters: {
    type: 'object',
    properties: {
      callSid: {
        type: 'string',
        description: 'The Call SID (starts with CA...)',
      },
    },
    required: ['callSid'],
  },
  handler: async (args: any, context) => {
    const creds = await resolveCredentials(context);

    if (!creds.accountSid || !creds.authToken) {
      throw new Error('Twilio credentials not configured');
    }

    if (!args.callSid || !args.callSid.startsWith('CA')) {
      throw new Error(`Invalid call SID: "${args.callSid}". Must start with "CA".`);
    }

    // Fetch call details and recordings in parallel
    const [callRes, recordingsRes] = await Promise.all([
      twilioRequest(creds, `/Calls/${args.callSid}.json`),
      twilioRequest(creds, `/Calls/${args.callSid}/Recordings.json`),
    ]);

    if (!callRes.ok) {
      await handleTwilioError(callRes, `Get call ${args.callSid}`);
    }

    const call = (await callRes.json()) as any;

    // Recordings may fail if none exist — that's OK
    let recordings: any[] = [];
    if (recordingsRes.ok) {
      const recData = (await recordingsRes.json()) as any;
      recordings = (recData.recordings || []).map((r: any) => ({
        sid: r.sid,
        duration: r.duration ? parseInt(r.duration, 10) : null,
        // @todo nira - 2026.10.18 : recording media URL requires auth to download;
        // consider adding a download-recording tool if needed
        media_url: `https://api.twilio.com/2010-04-01/Accounts/${creds.accountSid}/Recordings/${r.sid}.mp3`,
        status: r.status,
        channels: r.channels,
        source: r.source,
      }));
    }

    return {
      sid: call.sid,
      to: call.to,
      from: call.from,
      status: call.status,
      direction: call.direction,
      duration: call.duration ? parseInt(call.duration, 10) : null,
      start_time: call.start_time,
      end_time: call.end_time,
      price: call.price,
      price_unit: call.price_unit,
      answered_by: call.answered_by || null,
      caller_name: call.caller_name || null,
      forwarded_from: call.forwarded_from || null,
      recordings,
    };
  },
});

// =============================================================================
// START SERVER
// =============================================================================

server.start().catch((error) => {
  console.error('[Twilio MCA] Fatal error:', error);
  process.exit(1);
});
