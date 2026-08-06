/**
 * Permission description helper for `mca.netlify`.
 *
 * Used during `status === 'pending_permission'` to give the user a clear,
 * natural-language summary of what the agent wants to do BEFORE they grant
 * access. `deploy-site` is the load-bearing case: it publishes a workspace
 * directory to a PUBLIC URL, so the copy makes the exposure explicit (the
 * directory is chosen by the LLM — a prompt-injection surface).
 *
 * Follows the per-MCA pattern (TER-281): each MCA owns its permission copy
 * instead of a central monolith. Returns plain text (the renderer passes it as
 * `ToolCallCard`'s `description`); returns `null` for unrecognised tools so the
 * card falls back to its default verb-based phrasing.
 */

export interface NetlifyPermissionInput {
  dir?: string;
  siteId?: string;
  siteName?: string;
  draft?: boolean;
  allowWorkspaceRoot?: boolean;
  deployId?: string;
}

/**
 * Build the permission description for a Netlify tool. `shortName` is the bare
 * tool name (e.g. `deploy-site`) — extract via `getShortToolName(toolName)`.
 */
export function getNetlifyPermissionDescription(
  shortName: string,
  input: NetlifyPermissionInput | undefined,
): string | null {
  switch (shortName) {
    case 'deploy-site': {
      const dir = input?.dir;
      const target = input?.siteId
        ? `site ${input.siteId}`
        : input?.siteName
          ? `site "${input.siteName}"`
          : 'a new site';
      const where = dir ? `"${dir}"` : 'a workspace directory';
      const mode = input?.draft
        ? 'as a private draft preview'
        : 'PUBLICLY to the live internet';
      const rootWarning =
        input?.allowWorkspaceRoot === true
          ? ' This includes the ENTIRE workspace root — every file in the workspace will be public.'
          : '';
      return (
        `Wants to deploy ${where} to ${target} on Netlify, ${mode}. ` +
        `Anyone with the URL will be able to read these files — make sure the directory holds ` +
        `no secrets (.env), credentials, or private data.${rootWarning}`
      );
    }

    case 'list-sites':
      return 'Wants to list the Netlify sites your token can access.';

    case 'get-deploy-status':
      return input?.deployId
        ? `Wants to read the status of Netlify deploy ${input.deployId}.`
        : 'Wants to read the status of a Netlify deploy.';

    case '-health-check':
      return 'Wants to verify the Netlify token and connectivity (read-only).';

    default:
      return null;
  }
}
