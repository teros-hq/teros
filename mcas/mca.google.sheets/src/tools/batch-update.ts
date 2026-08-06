import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const batchUpdate: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Execute advanced operations on a Google Spreadsheet using the Sheets API batchUpdate endpoint. Supports: adding/deleting/renaming sheets, cell formatting (bold, colors, borders, number format), conditional formatting, formulas, frozen rows/columns, data validation, protected ranges, and more. Pass an array of request objects following the Google Sheets API batchUpdate schema.',
  parameters: {
    type: 'object',
    properties: {
      spreadsheetId: {
        type: 'string',
        description: 'The ID of the spreadsheet',
      },
      requests: {
        type: 'array',
        description:
          'Array of batchUpdate request objects. Each object is a key mapped to its request type. ' +
          'Common types: addSheet, deleteSheet, updateSheetProperties (rename, tabColor, gridProperties like frozenRowCount), ' +
          'repeatCell (formatting: textFormat with bold/italic/fontSize/foregroundColor, backgroundColor, numberFormat, borders), ' +
          'addConditionalFormatRule, setDataValidation, addProtectedRange, autoResizeDimensions, ' +
          'updateBorders, mergeCells, unmergeCells, addChart, addPivotTable. ' +
          'See https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/request for full schema.',
        items: {
          type: 'object',
        },
      },
    },
    required: ['spreadsheetId', 'requests'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { spreadsheetId, requests } = args as {
      spreadsheetId: string;
      requests: any[];
    };

    if (!requests || requests.length === 0) {
      return {
        success: false,
        message: 'No requests provided',
      };
    }

    return withAuthRetry(
      context,
      async () => {
        const response = await clients.sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: { requests },
        });

        return {
          success: true,
          replies: response.data.replies,
          spreadsheetId,
          operationsPerformed: requests.length,
        };
      },
      'batch-update',
    );
  },
};
