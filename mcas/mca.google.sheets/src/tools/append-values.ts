import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const appendValues: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Append rows of data to the end of a sheet in a Google Spreadsheet. Finds the last row with data and appends below it. Supports formulas (strings starting with =).',
  parameters: {
    type: 'object',
    properties: {
      spreadsheetId: {
        type: 'string',
        description: 'The ID of the spreadsheet',
      },
      range: {
        type: 'string',
        description: 'A1 notation range to start appending from (e.g. "Sheet1!A1" or "A1"). The API finds the last row with data in this range and appends below.',
      },
      values: {
        type: 'array',
        description: '2D array of rows to append. Each row is an array of cell values.',
        items: {
          type: 'array',
          items: {},
        },
      },
    },
    required: ['spreadsheetId', 'range', 'values'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { spreadsheetId, range, values } = args as {
      spreadsheetId: string;
      range: string;
      values: any[][];
    };

    return withAuthRetry(
      context,
      async () => {
        const response = await clients.sheets.spreadsheets.values.append({
          spreadsheetId,
          range,
          valueInputOption: 'USER_ENTERED',
          insertDataOption: 'INSERT_ROWS',
          requestBody: {
            values,
          },
        });

        const updates = response.data.updates;

        return {
          success: true,
          updatedRange: updates?.updatedRange,
          updatedRows: updates?.updatedRows,
          updatedColumns: updates?.updatedColumns,
          updatedCells: updates?.updatedCells,
        };
      },
      'append-values',
    );
  },
};
