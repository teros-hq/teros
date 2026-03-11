import type { HttpToolConfig as ToolConfig } from '@teros/mca-sdk';
import { getCredentials, getOrganization, type SentryEvent, sentryRequest } from '../lib/index.js';

export const getEvent: ToolConfig = {
  description: 'Get detailed information about a specific event including full stack trace',
  parameters: {
    type: 'object',
    properties: {
      organization: {
        type: 'string',
        description: 'Organization slug. Optional if configured in credentials.',
      },
      project: {
        type: 'string',
        description: 'Project slug',
      },
      eventId: {
        type: 'string',
        description: 'The event ID',
      },
    },
    required: ['project', 'eventId'],
  },
  handler: async (args, context) => {
    const { authToken, organization: defaultOrg } = await getCredentials(context);
    const org = getOrganization(args.organization as string | undefined, defaultOrg);
    const project = args.project as string;
    const eventId = args.eventId as string;

    const event = await sentryRequest<SentryEvent>(
      authToken,
      `/projects/${org}/${project}/events/${eventId}/`,
    );

    // Extract stack trace if available
    let stackTrace = null;
    if (event.entries) {
      const exceptionEntry = event.entries.find((e) => e.type === 'exception');
      if (exceptionEntry?.data?.values) {
        stackTrace = exceptionEntry.data.values.map((ex) => ({
          type: ex.type,
          value: ex.value,
          stacktrace: ex.stacktrace?.frames?.map((f) => ({
            filename: f.filename,
            function: f.function,
            lineNo: f.lineNo,
            colNo: f.colNo,
            context: f.context,
            inApp: f.inApp,
          })),
        }));
      }
    }

    // Extract breadcrumbs
    const breadcrumbsEntry = event.entries?.find((e) => e.type === 'breadcrumbs');
    const breadcrumbs = (breadcrumbsEntry?.data as { values?: unknown[] })?.values?.slice(-10);

    return {
      eventID: event.eventID,
      title: event.title,
      message: event.message,
      dateCreated: event.dateCreated,
      user: event.user,
      sdk: event.sdk,
      contexts: event.contexts,
      tags: event.tags,
      stackTrace,
      breadcrumbs,
    };
  },
};
