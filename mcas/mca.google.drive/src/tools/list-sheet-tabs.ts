import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const listSheetTabs: ToolConfig = {
  description: 'List all sheets (tabs) in a Google Spreadsheet with their metadata.',
  parameters: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        description: 'ID of the Google Sheet file',
      },
    },
    required: ['fileId'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { fileId } = args as { fileId: string };

    return withAuthRetry(
      context,
      async () => {
        const response = await clients.sheets.spreadsheets.get({
          spreadsheetId: fileId,
          fields: 'sheets.properties',
        });

        const sheets =
          response.data.sheets?.map((sheet) => ({
            sheetId: sheet.properties?.sheetId,
            title: sheet.properties?.title,
            index: sheet.properties?.index,
            rowCount: sheet.properties?.gridProperties?.rowCount,
            columnCount: sheet.properties?.gridProperties?.columnCount,
          })) || [];

        return { sheets };
      },
      'list-sheet-tabs',
    );
  },
};
