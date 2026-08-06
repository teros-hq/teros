import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const writeValues: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Write data to a specific range in a Google Sheet. Overwrites existing values. Pass a 2D array of rows (each row is an array of cell values). Supports formulas (strings starting with =).',
  parameters: {
    type: 'object',
    properties: {
      spreadsheetId: {
        type: 'string',
        description: 'The ID of the spreadsheet',
      },
      range: {
        type: 'string',
        description: 'A1 notation range to write to (e.g. "Sheet1!A1:C3" or "A1:C3")',
      },
      values: {
        type: 'array',
        description: '2D array of rows. Each row is an array of cell values (string, number, or boolean).',
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
        const response = await clients.sheets.spreadsheets.values.update({
          spreadsheetId,
          range,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values,
          },
        });

        return {
          success: true,
          updatedRange: response.data.updatedRange,
          updatedRows: response.data.updatedRows,
          updatedColumns: response.data.updatedColumns,
          updatedCells: response.data.updatedCells,
        };
      },
      'write-values',
    );
  },
};
