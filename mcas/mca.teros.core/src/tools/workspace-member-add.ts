import type { ToolConfig } from '@teros/mca-sdk';

/**
 * add-workspace-member — Add a member to a workspace by email.
 *
 * MUW-14: The tool now accepts an email address instead of a userId.
 * If the email belongs to an existing Teros account, the member is added
 * as active immediately. If not, a pending membership is created and an
 * invitation email is sent.
 *
 * Response: { email, status: 'active'|'pending', invitationEmailSent: boolean }
 * The resolved userId is NEVER returned (Guard 1).
 */
export const workspaceMemberAdd: ToolConfig = {
  annotations: { readOnlyHint: false },
  description:
    'Add a member to a workspace by email. If the email belongs to an existing Teros account, the member is added as active immediately. If not, a pending membership is created and an invitation email is sent. Only workspace admins can use this tool.',
  parameters: {
    type: 'object',
    properties: {
      workspaceId: {
        type: 'string',
        description: 'The workspace ID',
      },
      email: {
        type: 'string',
        description: 'The email address of the person to invite',
        format: 'email',
      },
      role: {
        type: 'string',
        enum: ['admin', 'write', 'read'],
        description: 'Role for the member (owner is not allowed)',
      },
    },
    required: ['workspaceId', 'email', 'role'],
  },
  handler: async (args, context) => {
    // Backend response (post-fix): { success, message, workspaceId,
    // workspaceName, email, status, invitationEmailSent, role } — passed
    // through as-is; the resolved userId is never returned (Guard 1).
    return context.workspaceMemberAdd(
      args.workspaceId as string,
      args.email as string,
      args.role as string,
    );
  },
};
