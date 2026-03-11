import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const readSheetRange: ToolConfig = {
  description:
    'Read a specific range from a Google Sheet. More efficient than reading the entire sheet.',
  parameters: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        description: 'ID of the Google Sheet file',
      },
      range: {
        type: 'string',
        description: "Range to read in A1 notation (e.g., 'Sheet1!A1:D10', 'Sheet2!A:A')",
      },
      valueRenderOption: {
        type: 'string',
        enum: ['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA'],
        description:
          'How to render values: FORMATTED_VALUE (default), UNFORMATTED_VALUE, or FORMULA',
      },
    },
    required: ['fileId', 'range'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const {
      fileId,
      range,
      valueRenderOption = 'FORMATTED_VALUE',
    } = args as {
      fileId: string;
      range: string;
      valueRenderOption?: string;
    };

    return withAuthRetry(
      context,
      async () => {
        const response = await clients.sheets.spreadsheets.values.get({
          spreadsheetId: fileId,
          range,
          valueRenderOption,
        });

        return {
          range: response.data.range,
          values: response.data.values || [],
        };
      },
      'read-sheet-range',
    );
  },
};
