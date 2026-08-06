import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const createSpreadsheet: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Create a new Google Spreadsheet with a title and optional initial data. Returns the spreadsheet ID and URL.',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Title of the new spreadsheet',
      },
      sheets: {
        type: 'array',
        description: 'Optional: names of sheets (tabs) to create. Defaults to a single "Sheet1".',
        items: { type: 'string' },
      },
    },
    required: ['title'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { title, sheets: sheetNames } = args as {
      title: string;
      sheets?: string[];
    };

    if (typeof title !== 'string' || title.trim().length === 0) {
      throw new Error('title is required and must be a non-empty string.');
    }

    return withAuthRetry(
      context,
      async () => {
        const requestBody: any = {
          properties: { title },
        };

        if (sheetNames && sheetNames.length > 0) {
          requestBody.sheets = sheetNames.map((name) => ({
            properties: { title: name },
          }));
        }

        const response = await clients.sheets.spreadsheets.create({
          requestBody,
        });

        const spreadsheetId = response.data.spreadsheetId!;
        const spreadsheetUrl = response.data.spreadsheetUrl!;

        return {
          spreadsheetId,
          title,
          url: spreadsheetUrl,
          sheets: response.data.sheets?.map((s) => s.properties?.title || '') || [],
        };
      },
      'create-spreadsheet',
    );
  },
};
