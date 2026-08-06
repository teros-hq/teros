import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { ensureAuthenticated, initializeGoogleClients, withAuthRetry } from '../lib';

export const listForms: ToolConfig = {
  annotations: { readOnlyHint: true },
  description:
    'List all Google Forms in your Drive. Uses the Drive API to find files with the Google Forms MIME type.',
  parameters: {
    type: 'object',
    properties: {
      pageSize: {
        type: 'number',
        description: 'Maximum number of forms to return (default: 10, max: 100)',
        default: 10,
      },
      pageToken: {
        type: 'string',
        description: 'Pagination token from a previous response to get the next page',
      },
    },
  },
  handler: async (args, context) => {
    const clients = await initializeGoogleClients(context);
    await ensureAuthenticated(context);

    const { pageSize = 10, pageToken } = args as {
      pageSize?: number;
      pageToken?: string;
    };

    return withAuthRetry(
      context,
      async () => {
        const response = await clients.drive.files.list({
          q: "mimeType='application/vnd.google-apps.form' and trashed=false",
          pageSize: Math.min(pageSize, 100),
          pageToken: pageToken || undefined,
          fields: 'files(id, name, createdTime, modifiedTime, webViewLink), nextPageToken',
          orderBy: 'modifiedTime desc',
        });

        return {
          forms: (response.data.files || []).map((file) => ({
            id: file.id,
            name: file.name,
            createdTime: file.createdTime,
            modifiedTime: file.modifiedTime,
            webViewLink: file.webViewLink,
          })),
          nextPageToken: response.data.nextPageToken,
        };
      },
      'list-forms',
    );
  },
};
