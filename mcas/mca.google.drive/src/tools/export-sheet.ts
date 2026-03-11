import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import {
  ensureAuthenticated,
  initializeGoogleClients,
  saveToDownloads,
  withAuthRetry,
} from '../lib';

const EXPORT_MIME_TYPES: Record<string, string> = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  tsv: 'text/tab-separated-values',
};

export const exportSheet: ToolConfig = {
  description:
    'Export a Google Sheet to a specific format (CSV, XLSX, PDF, ODS, TSV). Downloads the exported file to local filesystem.',
  parameters: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        description: 'ID of the Google Sheet file to export',
      },
      format: {
        type: 'string',
        enum: ['csv', 'xlsx', 'pdf', 'ods', 'tsv'],
        description: 'Export format: csv, xlsx, pdf, ods, tsv (default: csv)',
      },
      outputPath: {
        type: 'string',
        description:
          'Optional: Local path where to save the exported file. Defaults to ~/Downloads/',
      },
      sheetName: {
        type: 'string',
        description:
          'Optional: Name of specific sheet to export (for CSV/TSV only). If not provided, exports first sheet.',
      },
    },
    required: ['fileId'],
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const {
      fileId,
      format = 'csv',
      outputPath,
      sheetName,
    } = args as {
      fileId: string;
      format?: string;
      outputPath?: string;
      sheetName?: string;
    };

    return withAuthRetry(
      context,
      async () => {
        // Get file info for the name
        const fileInfo = await clients.drive.files.get({
          fileId,
          fields: 'name',
        });

        const mimeType = EXPORT_MIME_TYPES[format] || EXPORT_MIME_TYPES.csv;

        // For CSV/TSV, we might need to specify the sheet
        let exportUrl = `https://docs.google.com/spreadsheets/d/${fileId}/export?format=${format}`;

        if (sheetName && (format === 'csv' || format === 'tsv')) {
          // Get sheet ID by name
          const spreadsheet = await clients.sheets.spreadsheets.get({
            spreadsheetId: fileId,
            fields: 'sheets.properties',
          });

          const sheet = spreadsheet.data.sheets?.find((s) => s.properties?.title === sheetName);

          if (sheet?.properties?.sheetId !== undefined) {
            exportUrl += `&gid=${sheet.properties.sheetId}`;
          }
        }

        // Export using drive API
        const response = await clients.drive.files.export(
          { fileId, mimeType },
          { responseType: 'arraybuffer' },
        );

        const buffer = Buffer.from(response.data as ArrayBuffer);
        const baseName = fileInfo.data.name?.replace(/\.[^/.]+$/, '') || 'export';
        const fileName = `${baseName}.${format}`;

        const savedPath = await saveToDownloads(buffer, fileName, outputPath);

        return {
          success: true,
          filePath: savedPath,
          format,
          size: buffer.length,
        };
      },
      'export-sheet',
    );
  },
};
