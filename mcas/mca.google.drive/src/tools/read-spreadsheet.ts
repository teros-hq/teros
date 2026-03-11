import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const readSpreadsheet: ToolConfig = {
  description: 'Read data from a Google Sheet.',
  parameters: {
    type: 'object',
    properties: {
      spreadsheetId: {
        type: 'string',
        description: 'The ID of the spreadsheet',
      },
      range: {
        type: 'string',
        description: "The range to read (e.g., 'Sheet1!A1:D10', default: first sheet)",
        default: 'A1:Z1000',
      },
    },
    required: ['spreadsheetId'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { spreadsheetId, range = 'A1:Z1000' } = args as {
      spreadsheetId: string;
      range?: string;
    };

    return withAuthRetry(
      context,
      async () => {
        const response = await clients.sheets.spreadsheets.values.get({
          spreadsheetId,
          range,
        });

        return {
          range: response.data.range,
          values: response.data.values || [],
        };
      },
      'read-spreadsheet',
    );
  },
};
